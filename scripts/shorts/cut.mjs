// scripts/shorts/cut.mjs — découpe chaque passage choisi en un mini-projet prêt à monter :
//   shorts/clip-NN/video.mp4        (passage ré-encodé, recadré en vertical si la source est horizontale)
//   shorts/clip-NN/transcript.json  (mots du passage, horaires recalés à 0)
//   shorts/clip-NN/meta.json        (titre, hook, description, hashtags, horaires dans la source, thème attribué)
// Écrit aussi shorts/matrix.json (liste des NN) pour le rendu en parallèle.
//
// Recadrage (SHORTS_CROP) : auto (défaut : source horizontale → 4:5), none, 4:5, 1:1, 9:16.
// Position du cadre (SHORTS_CROP_POS) : center (défaut), left, right.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { findVideo, probeVideo } from "../lib/util.mjs";
import { channelOf } from "../lib/styles.mjs";
import { SHORT_STYLES, pickShortStyles } from "../lib/short-styles.mjs";

// ---------- garde « à l'oreille » : une coupe ne mange jamais le début (ni la fin) d'un mot ----------
// La transcription place souvent le début d'un mot sur sa voyelle : un « s », « ch », « f » qui le précède (faible en
// volume mais aigu) serait coupé. On mesure le son toutes les 10 ms (volume global + aigus) et chaque morceau gardé
// démarre avant le premier son réel (≤ 0,5 s plus tôt) et va jusqu'au bout du dernier (≤ 0,4 s plus tard).
function soundActivity(src, start, dur) {
  try {
    const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", src, "-vn", "-ac", "1",
      "-ar", "16000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
    const x = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    const H = 160, n = Math.floor(x.length / H);
    if (n < 50) return null;
    const bb = new Float64Array(n), hf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s1 = 0, s2 = 0;
      for (let k = i * H; k < (i + 1) * H; k++) {
        const v = x[k] / 32768, d2 = k >= 2 ? (x[k] - 2 * x[k - 1] + x[k - 2]) / 32768 : 0;
        s1 += v * v; s2 += d2 * d2;
      }
      bb[i] = 10 * Math.log10(s1 / H + 1e-18); hf[i] = 10 * Math.log10(s2 / H + 1e-18);
    }
    const pct = (a, p) => { const s = Array.from(a).sort((u, v) => u - v); return s[Math.floor(p * (s.length - 1))]; };
    const thr = (a, m) => { const lo = pct(a, 0.1), hi = pct(a, 0.9); return lo + Math.max(m, 0.22 * (hi - lo)); };
    const tb = thr(bb, 6), th = thr(hf, 8);
    return Array.from(bb, (v, i) => v > tb || hf[i] > th);
  } catch { return null; }
}
function guardKeep(keep, act, dur) {
  if (!act) return { keep, moved: 0 };
  const fps = 100, n = act.length, fr = (t) => Math.max(0, Math.min(n - 1, Math.floor(t * fps)));
  const out = keep.map((x) => ({ ...x }));
  let moved = 0;
  out.forEach((r, i) => {
    const prevB = i > 0 ? out[i - 1].b : 0;
    let j = fr(r.a) - 1; const lo = fr(Math.max(prevB, r.a - 0.5));
    if (i > 0 && j >= lo && act[j]) {
      while (j >= lo && act[j]) j--;
      const na = Math.max(prevB, j >= lo ? (j + 1) / fps - 0.05 : r.a - 0.12);
      if (na < r.a - 1e-3) { r.a = na; moved++; }
    }
    const nxtA = i + 1 < keep.length ? keep[i + 1].a : dur;
    j = fr(r.b); const hi = fr(Math.min(nxtA, r.b + 0.4));
    if (i + 1 < keep.length && j < hi && act[j]) {
      while (j < hi && act[j]) j++;
      const nb = Math.min(nxtA, j < hi ? j / fps + 0.05 : r.b + 0.12);
      if (nb > r.b + 1e-3) { r.b = nb; moved++; }
    }
  });
  for (let i = 1; i < out.length; i++) if (out[i].a < out[i - 1].b) out[i].a = out[i - 1].b;
  return { keep: out.filter((r) => r.b - r.a > 0.04), moved };
}

const sel = JSON.parse(readFileSync("shorts/selection.json", "utf8"));
const tr = JSON.parse(readFileSync("content/transcript.json", "utf8"));
const src = findVideo();
if (!src) throw new Error("Aucune vidéo source dans input/.");
const info = probeVideo(src);
const mode = String(process.env.SHORTS_CROP || "auto").toLowerCase();
const pos = String(process.env.SHORTS_CROP_POS || "center").toLowerCase();
// auto : une vidéo horizontale est recadrée en 9:16 (la vidéo remplit alors ≈ 90 % de l'écran du short),
// centrée sur le visage du locuteur s'il a été détecté (shorts/source-face.json), sinon au centre.
const ratio = { "4:5": [4, 5], "1:1": [1, 1], "9:16": [9, 16] }[mode] || (mode === "auto" && info.width > info.height * 1.05 ? [9, 16] : null);
let faceCx = null;
try { const f = JSON.parse(readFileSync("shorts/source-face.json", "utf8")); if (f.found && f.cx > 0 && f.cx < 1) faceCx = f.cx; } catch {}
let vf = "";
if (ratio && mode !== "none") {
  const [rw, rh] = ratio;
  const cw = `trunc(min(iw\\,ih*${rw}/${rh})/2)*2`, ch = `trunc(min(ih\\,iw*${rh}/${rw})/2)*2`;
  const x = pos === "left" ? "0" : pos === "right" ? "iw-ow"
    : faceCx !== null ? `max(0\\,min(iw-ow\\,iw*${faceCx.toFixed(3)}-ow/2))` : "(iw-ow)/2";
  if (pos === "center" && faceCx !== null) console.log(`Recadrage centré sur le visage (x = ${Math.round(faceCx * 100)} % de la largeur)`);
  vf = `crop=${cw}:${ch}:${x}:(ih-oh)/2`;
}
console.log(`Source ${info.width}x${info.height}, ${info.duration.toFixed(0)} s — recadrage : ${vf ? `${ratio.join(":")} (${pos})` : "aucun"}`);

// styles SHORTS (lib/short-styles.mjs, distincts de Build Video) : un style différent par short, en évitant les
// derniers utilisés (historique "<chaîne>-shorts" dans state/style-history.json)
const channel = channelOf(sel.lang);
let history = {};
try { history = existsSync("state/style-history.json") ? JSON.parse(readFileSync("state/style-history.json", "utf8")) : {}; } catch {}
const forced = process.env.SHORT_STYLE && SHORT_STYLES.some((p) => p.id === process.env.SHORT_STYLE) ? process.env.SHORT_STYLE : null;
const styles = pickShortStyles(sel.clips.length, history[`${channel}-shorts`] || []);

const ids = [];
const TIGHT = Number(process.env.SHORTS_TIGHTEN ?? 0.45);
// un morceau de la source (un passage, ou un moment d'un best-of) → mots relatifs + morceaux gardés (silences retirés)
function pieceOf(start, end, tight) {
  const dur = end - start;
  const rel = tr.words.filter((w) => w.t0 >= start - 0.05 && w.t1 <= end + 0.12)
    .map((w) => ({ t0: Math.max(0, w.t0 - start), t1: Math.min(dur, Math.max(w.t0 - start + 0.05, w.t1 - start)), w: w.w }));
  let keep = [{ a: 0, b: dur }];
  if (tight > 0 && rel.length) {
    const iv = [];
    for (const w of rel) {
      const a = Math.max(0, w.t0 - 0.12), b = Math.min(dur, w.t1 + 0.14);
      const last = iv[iv.length - 1];
      if (last && a - last.b <= tight) last.b = Math.max(last.b, b); else iv.push({ a, b });
    }
    iv[0].a = 0; iv[iv.length - 1].b = dur;
    const removed = dur - iv.reduce((n, x) => n + (x.b - x.a), 0);
    if (removed >= 0.4 && iv.length <= 60) keep = iv;
  }
  let moved = 0;
  if (keep.length > 1) { const g = guardKeep(keep, soundActivity(src, start, dur), dur); keep = g.keep; moved = g.moved; }
  return { start, end, dur, rel, keep, moved };
}
const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart"];
for (const c of sel.clips) {
  const dir = `shorts/clip-${c.id}`;
  mkdirSync(dir, { recursive: true });
  const best = Array.isArray(c.segments) && c.segments.length > 0;
  // BEST-OF : plusieurs moments de la vidéo ; silences resserrés plus fort (0,3 s) : rythme maximal
  const segs = best ? c.segments : [{ start: c.start, end: c.end }];
  const pieces = segs.map((g) => pieceOf(g.start, g.end, best ? Math.min(TIGHT, 0.3) : TIGHT));
  const moved = pieces.reduce((n, p) => n + p.moved, 0);
  if (moved) console.log(`  #${c.id} : ${moved} coupe(s) décalée(s) pour ne manger aucun début ni fin de mot`);
  const dur = pieces.reduce((n, p) => n + p.dur, 0);
  const newDur = pieces.reduce((n, p) => n + p.keep.reduce((m, x) => m + (x.b - x.a), 0), 0);
  const fadeOut = `afade=t=out:st=${Math.max(0, newDur - 0.22).toFixed(3)}:d=0.22`;
  const nParts = pieces.reduce((n, p) => n + p.keep.length, 0);
  if (!best && nParts === 1) {
    // -ss avant -i + ré-encodage = coupe précise et rapide même sur une vidéo de plusieurs heures
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", c.start.toFixed(3), "-i", src, "-t", dur.toFixed(3),
      ...(vf ? ["-vf", vf] : []), "-map", "0:v:0", "-map", "0:a:0?", "-af", `afade=t=in:d=0.08,${fadeOut}`, ...enc, `${dir}/video.mp4`], { stdio: "inherit" });
  } else {
    // coupes exactes image et son (trim/atrim + concat), micro-fondus de 12 ms pour éviter les « clics » ;
    // une entrée par morceau de la source (les moments d'un best-of peuvent être très éloignés dans la vidéo)
    const ins = [], g = [], lab = [];
    pieces.forEach((p, k) => {
      ins.push("-ss", p.start.toFixed(3), "-t", p.dur.toFixed(3), "-i", src);
      p.keep.forEach((x, j) => {
        const n = `${k}_${j}`;
        g.push(`[${k}:v]trim=start=${x.a.toFixed(3)}:end=${x.b.toFixed(3)},setpts=PTS-STARTPTS${vf ? "," + vf : ""},fps=${info.fps},setsar=1[v${n}]`);
        g.push(`[${k}:a]atrim=start=${x.a.toFixed(3)}:end=${x.b.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, x.b - x.a - 0.012).toFixed(3)}:d=0.012[a${n}]`);
        lab.push(`[v${n}][a${n}]`);
      });
    });
    let fc = `${g.join(";")};${lab.join("")}concat=n=${lab.length}:v=1:a=1[cv0][ca0];[ca0]afade=t=in:d=0.06,${fadeOut}[ca]`;
    if (c.loop && newDur > 6) {
      // BOUCLE : les 0,35 dernières secondes se fondent dans la toute 1re image → au replay, aucune coupure visible
      const X = 0.35;
      fc += `;[cv0]split[cm][cf];[cf]trim=end_frame=1,loop=loop=-1:size=1,trim=duration=${(X + 0.05).toFixed(3)},setpts=PTS-STARTPTS[first];` +
        `[cm][first]xfade=transition=fade:duration=${X}:offset=${(newDur - X).toFixed(3)},trim=duration=${newDur.toFixed(3)}[cv]`;
    } else fc += ";[cv0]null[cv]";
    execFileSync("ffmpeg", ["-y", "-v", "error", ...ins, "-filter_complex", fc, "-map", "[cv]", "-map", "[ca]", ...enc, `${dir}/video.mp4`], { stdio: "inherit" });
  }
  // horaires des mots recalés sur la vidéo resserrée (morceau après morceau)
  const words = [], cutsAt = [], moments = [];
  let base = 0;
  pieces.forEach((p, k) => {
    const offs = []; { let o = 0; for (const x of p.keep) { offs.push(o); o += x.b - x.a; } }
    const len = p.keep.reduce((m, x) => m + (x.b - x.a), 0);
    const remap = (t) => { for (let j = p.keep.length - 1; j >= 0; j--) if (t >= p.keep[j].a - 1e-6) return offs[j] + Math.min(t, p.keep[j].b) - p.keep[j].a; return 0; };
    p.rel.forEach((w) => words.push({ t0: +(base + remap(w.t0)).toFixed(3), t1: +(base + Math.max(remap(w.t0) + 0.05, remap(w.t1))).toFixed(3), w: w.w }));
    if (k > 0) cutsAt.push(+base.toFixed(3));
    offs.slice(1).forEach((o) => cutsAt.push(+(base + o).toFixed(3)));
    moments.push({ t0: +base.toFixed(3), t1: +(base + len).toFixed(3), type: segs[k].type || "", resume: segs[k].resume || "" });
    base += len;
  });
  if (nParts > 1) console.log(`  #${c.id} : ${(dur - newDur).toFixed(1)} s de silences retirés${best ? `, ${pieces.length} moments enchaînés` : ""} (${nParts - 1} coupes)`);
  if (!words.length) { console.log(`  #${c.id} : aucun mot dans le passage, ignoré.`); continue; }
  writeFileSync(`${dir}/transcript.json`, JSON.stringify({ lang: tr.lang, duration: +newDur.toFixed(3), words, cuts: cutsAt, ...(best ? { moments } : {}) }, null, 1));
  const theme = forced || styles[sel.clips.indexOf(c)];
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ ...c, final_duration: +newDur.toFixed(2), silences_removed: +(dur - newDur).toFixed(2), theme, channel, crop: vf ? ratio.join(":") : "none" }, null, 2));
  console.log(`  #${c.id} : ${newDur.toFixed(1)} s (${best ? `${pieces.length} moments` : `passage ${dur.toFixed(1)} s`}), ${words.length} mots, thème ${theme}`);
  ids.push(c.id);
}
if (!ids.length) throw new Error("Aucun short n'a pu être découpé.");
writeFileSync("shorts/matrix.json", JSON.stringify(ids));
console.log(`${ids.length} passage(s) prêt(s) : ${ids.join(", ")}`);
