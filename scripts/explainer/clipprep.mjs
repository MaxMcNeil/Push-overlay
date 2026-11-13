// scripts/explainer/clipprep.mjs — enregistrements d'écran BRUTS du téléphone → vidéo propre, prête à monter.
//  1) RECADRAGE : garde seulement la zone où l'image bouge (le lecteur vidéo) ; retire barre d'état, barre de navigation,
//     titre, commentaires, boutons, bandes noires. Une vidéo normale (plein cadre) n'est pas touchée.
//  2) DÉCOUPE : retire le début et la fin « hors vidéo » (ouverture de l'appli, défilement, écran figé, arrêt de
//     l'enregistrement) : on garde du premier au dernier instant où la vidéo joue (image qui bouge dans le lecteur, ou son)
//     pendant que le reste de l'écran est stable. Le milieu n'est jamais coupé.
// Sans dépendance : ffmpeg + calcul en JavaScript sur des images réduites en niveaux de gris. En cas de doute : on ne touche à rien.
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";

const FPS = 2, W = 160;

function frames(file, w, h, dur) {
  const fh = Math.max(2, Math.round((W * h) / w / 2) * 2);
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-t", String(Math.min(dur, 900)), "-an", "-vf", `fps=${FPS},scale=${W}:${fh}:flags=area,format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 30, timeout: 600000 });
  const n = Math.floor(buf.length / (W * fh)), out = [];
  for (let k = 0; k < n; k++) out.push(buf.subarray(k * W * fh, (k + 1) * W * fh));
  return { fw: W, fh, list: out };
}

/** Plus longue bande contiguë où le profil dépasse le seuil (tolère de petits trous). */
function band(profile, thr, gap = 2) {
  let best = null, s = -1, last = -1;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && profile[i] >= thr;
    if (on) { if (s < 0) s = i; last = i; }
    else if (s >= 0 && (i - last > gap || i === profile.length)) {
      if (!best || last - s > best[1] - best[0]) best = [s, last];
      s = -1;
    }
  }
  return best;
}

/** Zone utile (lecteur vidéo) en fraction de l'image, ou null si plein cadre / indécidable.
 *  Fréquence de mouvement par pixel, calculée seulement sur les instants « calmes » (moins de 60 % de l'écran change) :
 *  le défilement de l'appli (tout l'écran bouge) ne compte pas, la vidéo qui joue dans le lecteur si. */
export function cropBox(fr) {
  const r = cropBox0(fr);
  return r;
}
let LAST = "";
function cropBox0({ fw, fh, list }) {
  LAST = "incertain";
  if (list.length < 4) return null;
  const n = fw * fh, freq = new Float64Array(n);
  let calm = 0;
  const changed = new Uint8Array(n);
  for (let k = 1; k < list.length; k++) {
    const a = list[k - 1], b = list[k];
    let c = 0;
    for (let i = 0; i < n; i++) { changed[i] = Math.abs(a[i] - b[i]) > 4 ? 1 : 0; c += changed[i]; }
    if (c / n > 0.6 || c / n < 0.002) continue;            // défilement plein écran, ou image figée : instant ignoré
    calm++;
    for (let i = 0; i < n; i++) freq[i] += changed[i];
  }
  if (calm < 3) return null;
  const act = new Uint8Array(n);
  // un pixel du lecteur change au moins de temps en temps (même une interview au décor fixe : visage, coupes, bruit de
  // compression) ; l'interface du téléphone ne change jamais pendant que la vidéo joue
  for (let i = 0; i < n; i++) act[i] = freq[i] / calm >= 0.06 ? 1 : 0;
  const rows = new Float64Array(fh), cols = new Float64Array(fw);
  for (let y = 0; y < fh; y++) { let s = 0; for (let x = 0; x < fw; x++) s += act[y * fw + x]; rows[y] = s / fw; }
  const rb = band(rows, 0.3);
  if (!rb) return null;
  for (let x = 0; x < fw; x++) { let s = 0; for (let y = rb[0]; y <= rb[1]; y++) s += act[y * fw + x]; cols[x] = s / (rb[1] - rb[0] + 1); }
  const cb = band(cols, 0.3);
  if (!cb) return null;
  const pad = 0;
  const x0 = Math.max(0, cb[0] - pad), x1 = Math.min(fw - 1, cb[1] + pad), y0 = Math.max(0, rb[0] - pad), y1 = Math.min(fh - 1, rb[1] + pad);
  let box = { x: x0 / fw, y: y0 / fh, w: (x1 - x0 + 1) / fw, h: (y1 - y0 + 1) / fh };
  // garde-fou : un lecteur vidéo a une forme standard (16:9, 9:16, 4:3, 1:1…). Une zone de forme bizarre = seule une partie
  // de l'image bougeait (visage d'une interview au décor fixe) : on l'élargit à la forme standard la plus proche.
  const ar = (box.w * fw) / (box.h * fh), STD = [16 / 9, 9 / 16, 4 / 3, 3 / 4, 1, 21 / 9];
  const near = STD.reduce((a, b) => (Math.abs(Math.log(b / ar)) < Math.abs(Math.log(a / ar)) ? b : a));
  if (Math.abs(Math.log(near / ar)) > 0.12) {
    let pw = box.w * fw, ph = box.h * fh;
    if (near > ar) pw = Math.min(fw, ph * near); else ph = Math.min(fh, pw / near);
    const cx = (box.x + box.w / 2) * fw, cy = (box.y + box.h / 2) * fh;
    const nx = Math.min(Math.max(0, cx - pw / 2), fw - pw), ny = Math.min(Math.max(0, cy - ph / 2), fh - ph);
    box = { x: nx / fw, y: ny / fh, w: pw / fw, h: ph / fh };
  }
  if (box.w * box.h > 0.9) { LAST = "plein"; return null; }   // déjà plein cadre : rien à recadrer
  if (box.w < 0.3 || box.h < 0.12) return null;            // zone minuscule : douteux, on ne touche à rien
  LAST = "recadree";
  return box;
}

/** Instants (s) où la vidéo joue : image qui bouge DANS le lecteur et reste de l'écran stable (pas de défilement). */
export function activeSpan({ fw, fh, list }, box) {
  const inBox = (x, y) => !box || (x >= box.x * fw && x < (box.x + box.w) * fw && y >= box.y * fh && y < (box.y + box.h) * fh);
  const act = [];
  for (let k = 1; k < list.length; k++) {
    let din = 0, nin = 0, dout = 0, nout = 0;
    const a = list[k - 1], b = list[k];
    for (let y = 0; y < fh; y += 2) for (let x = 0; x < fw; x += 2) {
      const i = y * fw + x, d = Math.abs(a[i] - b[i]);
      if (inBox(x, y)) { din += d; nin++; } else { dout += d; nout++; }
    }
    const mi = nin ? din / nin : 0, mo = nout ? dout / nout : 0;
    // reste de l'écran qui change beaucoup = défilement, changement d'appli, fin de l'enregistrement : pas « la vidéo »
    act.push(mi > 1.2 && (!box || mo < Math.min(10, Math.max(4, mi * 0.6))));
  }
  const first = act.indexOf(true), last = act.lastIndexOf(true);
  if (first < 0) return null;
  return { t0: first / FPS, t1: (last + 1) / FPS };
}

function soundSpan(file, dur) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "silencedetect=n=-40dB:d=0.6", "-f", "null", "-"],
    { encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) return null;               // son illisible : on se fie à l'image seule
  return parseSilence(r.stderr || "", dur);
}
function parseSilence(log, dur) {
  const st = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]), en = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  if (!st.length) return { t0: 0, t1: dur };
  const t0 = st[0] <= 0.05 && en.length ? en[0] : 0;
  // silence final : soit non refermé, soit refermé à la toute fin du fichier
  const lastEnd = en.length ? en[en.length - 1] : 0;
  const t1 = st.length > en.length || (lastEnd >= dur - 0.4 && st[st.length - 1] > t0) ? st[st.length - 1] : dur;
  return t1 - t0 > 0.5 ? { t0, t1 } : null;
}

/** Prépare un enregistrement d'écran. Retourne { file, p, notes[] } : le fichier propre (ou l'original si rien à faire). */
export function prepClip(v, outDir = "content/clips-prep", force = null) {
  const notes = [];
  // extraits audio transformés en « onde sonore » par fetch.sh : rien à recadrer ni couper
  if (process.env.EXPLAINER_CLIP_PREP === "non" || !v.p || /\.audio\.mp4$/i.test(v.file)) return { file: v.file, p: v.p, notes, status: "plein" };
  try {
    const fr = frames(v.file, v.p.w, v.p.h, v.p.dur);
    const box = force?.box || cropBox(fr), status = force?.box ? "recadree" : LAST;
    const vid = activeSpan(fr, box), snd = v.p.audio ? soundSpan(v.file, v.p.dur) : null;
    // début = première image qui joue (le son seul ne suffit pas : bruit d'appli) ; fin = dernière image OU dernier son
    let t0 = force && isFinite(force.t0) ? force.t0 : vid ? vid.t0 : 0;
    // plein écran (aucun recadrage) : le défilement de l'appli ressemble à une vidéo qui bouge ; le début du SON de la
    // vidéo (enregistrement avec le son interne) départage, dans les 20 premières secondes
    if (!box && snd && snd.t0 > t0 && snd.t0 <= 20) t0 = snd.t0;
    let t1 = force && isFinite(force.t1) ? force.t1 : Math.min(v.p.dur, Math.max(vid ? vid.t1 + 0.4 : v.p.dur, snd && vid ? Math.min(snd.t1, vid.t1 + 3) : 0));
    if (t0 < 0.8) t0 = 0;
    if (v.p.dur - t1 < 0.8) t1 = v.p.dur;
    if (t1 - t0 < Math.min(2, v.p.dur * 0.5)) { t0 = 0; t1 = v.p.dur; }          // découpe absurde : on garde tout
    const trim = t0 > 0 || t1 < v.p.dur;
    if (!box && !trim) return { file: v.file, p: v.p, notes, status, t0, t1 };
    let crop = [];
    if (box) {
      const even = (x) => Math.max(2, Math.floor(x / 2) * 2);
      const cw = even(box.w * v.p.w), ch = even(box.h * v.p.h), cx = even(box.x * v.p.w), cy = even(box.y * v.p.h);
      crop = [`crop=${Math.min(cw, v.p.w - cx)}:${Math.min(ch, v.p.h - cy)}:${cx}:${cy}`];
      notes.push(`recadrée sur le lecteur (${Math.round(box.w * 100)} % × ${Math.round(box.h * 100)} % de l'écran)`);
    }
    if (trim) notes.push(`découpée ${t0.toFixed(1)} s → ${t1.toFixed(1)} s (début/fin hors vidéo retirés)`);
    mkdirSync(outDir, { recursive: true });
    const out = path.resolve(outDir, path.basename(v.file).replace(/\.[^.]+$/, "") + ".prep.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t0.toFixed(3), "-to", t1.toFixed(3), "-i", v.file,
      ...(crop.length ? ["-vf", crop.join(",")] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      ...(v.p.audio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]), "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"], timeout: 1800000 });
    if (!existsSync(out)) return { file: v.file, p: v.p, notes: [], status, t0, t1 };
    return { file: out, notes, status, t0, t1 };
  } catch (e) {
    return { file: v.file, p: v.p, notes: [`préparation impossible (${String(e.message).slice(0, 80)}) : vidéo gardée telle quelle`], status: "incertain" };
  }
}
