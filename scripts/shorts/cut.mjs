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
for (const c of sel.clips) {
  const dir = `shorts/clip-${c.id}`;
  mkdirSync(dir, { recursive: true });
  const dur = c.end - c.start;
  // mots ENTIÈREMENT dans le passage (pas de mot à moitié coupé dans les sous-titres), en temps relatif
  const rel = tr.words.filter((w) => w.t0 >= c.start - 0.05 && w.t1 <= c.end + 0.12)
    .map((w) => ({ t0: Math.max(0, w.t0 - c.start), t1: Math.min(dur, Math.max(w.t0 - c.start + 0.05, w.t1 - c.start)), w: w.w }));
  // RYTHME : les silences > TIGHT s sont retirés (coupes sèches entre les phrases = meilleure rétention).
  // Chaque morceau de parole garde une petite marge ; le rendu masque chaque coupe par un changement de cadrage.
  const TIGHT = Number(process.env.SHORTS_TIGHTEN ?? 0.45);
  let keep = [{ a: 0, b: dur }];
  if (TIGHT > 0 && rel.length) {
    const iv = [];
    for (const w of rel) {
      const a = Math.max(0, w.t0 - 0.08), b = Math.min(dur, w.t1 + 0.14);
      const last = iv[iv.length - 1];
      if (last && a - last.b <= TIGHT) last.b = Math.max(last.b, b); else iv.push({ a, b });
    }
    iv[0].a = 0; iv[iv.length - 1].b = dur; // début et fin d'origine conservés (marges + fondu)
    const removed = dur - iv.reduce((n, x) => n + (x.b - x.a), 0);
    if (removed >= 0.4 && iv.length <= 60) keep = iv;
  }
  const newDur = keep.reduce((n, x) => n + (x.b - x.a), 0);
  const fadeOut = `afade=t=out:st=${Math.max(0, newDur - 0.22).toFixed(3)}:d=0.22`;
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart"];
  if (keep.length === 1) {
    // -ss avant -i + ré-encodage = coupe précise et rapide même sur une vidéo de plusieurs heures
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", c.start.toFixed(3), "-i", src, "-t", dur.toFixed(3),
      ...(vf ? ["-vf", vf] : []), "-map", "0:v:0", "-map", "0:a:0?", "-af", `afade=t=in:d=0.08,${fadeOut}`, ...enc, `${dir}/video.mp4`], { stdio: "inherit" });
  } else {
    // coupes exactes image et son (trim/atrim + concat), micro-fondus de 12 ms pour éviter les « clics »
    const g = keep.map((x, k) => `[0:v]trim=start=${x.a.toFixed(3)}:end=${x.b.toFixed(3)},setpts=PTS-STARTPTS${vf ? "," + vf : ""}[v${k}];` +
      `[0:a]atrim=start=${x.a.toFixed(3)}:end=${x.b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, x.b - x.a - 0.012).toFixed(3)}:d=0.012[a${k}]`).join(";");
    const fc = `${g};${keep.map((_, k) => `[v${k}][a${k}]`).join("")}concat=n=${keep.length}:v=1:a=1[cv][ca0];[ca0]afade=t=in:d=0.06,${fadeOut}[ca]`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", c.start.toFixed(3), "-t", dur.toFixed(3), "-i", src, "-filter_complex", fc, "-map", "[cv]", "-map", "[ca]", ...enc, `${dir}/video.mp4`], { stdio: "inherit" });
  }
  // horaires des mots recalés sur la vidéo resserrée
  const offs = []; { let o = 0; for (const x of keep) { offs.push(o); o += x.b - x.a; } }
  const remap = (t) => { for (let k = keep.length - 1; k >= 0; k--) if (t >= keep[k].a - 1e-6) return offs[k] + Math.min(t, keep[k].b) - keep[k].a; return 0; };
  const words = rel.map((w) => ({ t0: +remap(w.t0).toFixed(3), t1: +Math.max(remap(w.t0) + 0.05, remap(w.t1)).toFixed(3), w: w.w }));
  const cutsAt = keep.slice(1).map((_, k) => +offs[k + 1].toFixed(3)); // instants des coupes (pour le rendu)
  if (keep.length > 1) console.log(`  #${c.id} : ${(dur - newDur).toFixed(1)} s de silences retirés (${keep.length - 1} coupes)`);
  if (!words.length) { console.log(`  #${c.id} : aucun mot dans le passage, ignoré.`); continue; }
  writeFileSync(`${dir}/transcript.json`, JSON.stringify({ lang: tr.lang, duration: +newDur.toFixed(3), words, cuts: cutsAt }, null, 1));
  const theme = forced || styles[sel.clips.indexOf(c)];
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ ...c, final_duration: +newDur.toFixed(2), silences_removed: +(dur - newDur).toFixed(2), theme, channel, crop: vf ? ratio.join(":") : "none" }, null, 2));
  console.log(`  #${c.id} : ${newDur.toFixed(1)} s (passage ${dur.toFixed(1)} s), ${words.length} mots, thème ${theme}`);
  ids.push(c.id);
}
if (!ids.length) throw new Error("Aucun short n'a pu être découpé.");
writeFileSync("shorts/matrix.json", JSON.stringify(ids));
console.log(`${ids.length} passage(s) prêt(s) : ${ids.join(", ")}`);
