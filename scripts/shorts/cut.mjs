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
import { PRESETS, channelOf, pickStyle } from "../lib/styles.mjs";

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

// thèmes : un thème différent par short, en évitant les derniers utilisés sur la chaîne
const channel = channelOf(sel.lang);
let history = {};
try { history = existsSync("state/style-history.json") ? JSON.parse(readFileSync("state/style-history.json", "utf8")) : {}; } catch {}
const forced = process.env.STYLE_ID && PRESETS.some((p) => p.id === process.env.STYLE_ID) ? process.env.STYLE_ID : null;
const h = { ...history, [channel]: [...(history[channel] || [])] };

const ids = [];
for (const c of sel.clips) {
  const dir = `shorts/clip-${c.id}`;
  mkdirSync(dir, { recursive: true });
  const dur = c.end - c.start;
  // -ss avant -i + ré-encodage = coupe précise et rapide même sur une vidéo de plusieurs heures
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", c.start.toFixed(3), "-i", src, "-t", dur.toFixed(3),
    ...(vf ? ["-vf", vf] : []), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", `${dir}/video.mp4`], { stdio: "inherit" });
  const words = tr.words.filter((w) => w.t0 >= c.start - 0.05 && w.t1 <= c.end + 0.3)
    .map((w) => ({ t0: +Math.max(0, w.t0 - c.start).toFixed(3), t1: +Math.min(dur, Math.max(w.t0 - c.start + 0.05, w.t1 - c.start)).toFixed(3), w: w.w }));
  if (!words.length) { console.log(`  #${c.id} : aucun mot dans le passage, ignoré.`); continue; }
  writeFileSync(`${dir}/transcript.json`, JSON.stringify({ lang: tr.lang, duration: +dur.toFixed(3), words }, null, 1));
  const theme = forced || pickStyle({ channel, history: h, avoid: Math.min(PRESETS.length - 1, 3 + ids.length) }).id;
  h[channel].push(theme);
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ ...c, theme, channel, crop: vf ? ratio.join(":") : "none" }, null, 2));
  console.log(`  #${c.id} : ${dur.toFixed(1)} s, ${words.length} mots, thème ${theme}`);
  ids.push(c.id);
}
if (!ids.length) throw new Error("Aucun short n'a pu être découpé.");
writeFileSync("shorts/matrix.json", JSON.stringify(ids));
console.log(`${ids.length} passage(s) prêt(s) : ${ids.join(", ")}`);
