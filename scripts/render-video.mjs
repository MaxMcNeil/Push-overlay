// scripts/render-video.mjs
// Rend la vidéo finale (output/final.mp4) : la vidéo d'origine n'occupe JAMAIS
// 100 % de l'écran. Elle vit dans une fenêtre arrondie, sur un fond animé
// (copie floutée + dérive de teinte), avec : hook d'ouverture, bandeau de
// headline, cartes d'analyse en split-screen, zooms punch, sous-titres mot à
// mot, emojis, flèches, ticker de disclaimers permanent, barre de progression,
// effets sonores synthétiques et transitions flash.
// Tout est généré par ffmpeg + libass : aucun service externe.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { CONTENT_DIR, OUTPUT_DIR, findVideo, probeVideo, listFontFiles } from "./lib/util.mjs";
import { Ass, PALETTE, c1, c3, c4, rrect, esc } from "./lib/ass.mjs";
import { measureTokens, measureLine } from "./lib/measure.mjs";

const plan = JSON.parse(readFileSync(`${CONTENT_DIR}/plan.json`, "utf8"));
const tr = JSON.parse(readFileSync(`${CONTENT_DIR}/transcript.json`, "utf8"));
const videoPath = findVideo();
if (!videoPath) throw new Error("Aucune vidéo dans input/.");
const info = probeVideo(videoPath);
// Durées RÉELLEMENT décodables : une vidéo téléchargée (TikTok…) peut annoncer 3:58 dans l'en-tête
// alors que sa piste image est plus courte ou à fréquence variable. On mesure, on ne suppose pas.
function measureDecoded(file, kind) {
  const map = kind === "v" ? ["-map", "0:v:0", "-an"] : ["-map", "0:a:0", "-vn"];
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostats", "-progress", "pipe:1", "-i", file, ...map, "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const m = [...(r.stdout?.toString() || "").matchAll(/out_time_us=(\d+)/g)].pop();
  return m ? Number(m[1]) / 1e6 : 0;
}
const decV = measureDecoded(videoPath, "v");
const decA = info.hasAudio ? measureDecoded(videoPath, "a") : 0;
console.log(`Durées : conteneur ${info.duration.toFixed(1)} s | image décodée ${decV.toFixed(1)} s | audio décodé ${decA.toFixed(1)} s`);
const D = Math.min(Math.max(decV, decA, 1), info.duration || 1e9, plan.duration + 1);
// si l'image s'arrête avant le son, on fige la dernière image au lieu de couper la vidéo
const padSec = Math.max(0, D - decV);
if (padSec > 0.5) console.log(`⚠ La piste image s'arrête ${padSec.toFixed(1)} s avant la fin : dernière image figée pour ne pas couper le son.`);
const lang = plan.lang;
const rtl = lang === "ar";

// ---------- thème visuel (voir lib/styles.mjs) : absent = rendu d'origine ----------
const theme = (() => {
  try { return existsSync(`${CONTENT_DIR}/theme.json`) ? JSON.parse(readFileSync(`${CONTENT_DIR}/theme.json`, "utf8")) : {}; } catch { return {}; }
})();
const T = { radius: 26, transition: "bands", subAnim: "pop", bullet: "dot", flip: false, progress: "bottom", subsDy: 0, sfx: 0, energy: "high", frame: "white", pill: "round", hueSpeed: 24, sat: 1.6, tilt: true, ...theme };
const MV = { hueOffset: 0, subsScale: 1, flareScale: 1, bgDark: -0.2, gradSpeed: 0.03, ...(theme.micro || {}) };
const P = { ...PALETTE, ...(theme.palette || {}) };
const GRAD = theme.gradient || ["FF2E63", "08D9D6", "7B2FF7"];
const layoutRTL = rtl !== !!T.flip; // côté de la carte d'analyse (le logo et la headline ne bougent pas : identité de chaîne)
console.log(`Thème : ${theme.id || "neon-night (défaut)"}`);

// ---------- orientation : suit la vidéo (ou content/orientation.txt si présent) ----------
let vertical = info.height > info.width;
if (existsSync(`${CONTENT_DIR}/orientation.txt`)) {
  const f = readFileSync(`${CONTENT_DIR}/orientation.txt`, "utf8").trim().toLowerCase();
  if (f === "vertical") vertical = true;
  if (f === "horizontal") vertical = false;
  if (f === "vertical" || f === "horizontal") console.log(`Orientation imposée par content/orientation.txt : ${f} (supprime ce fichier pour suivre la vidéo)`);
}
const W = vertical ? 1080 : 1920;
const H = vertical ? 1920 : 1080;
const FPS = info.fps;
const srcAspect = info.width / info.height;
console.log(`Source ${info.width}x${info.height} → sortie ${W}x${H} (${vertical ? "vertical" : "horizontal"}), ${D.toFixed(1)} s, langue ${lang}`);

// ---------- polices ----------
const files = listFontFiles();
function familyOf(file, want) {
  const r = spawnSync("fc-scan", ["--format", "%{family}\\n", file]);
  const fams = (r.stdout?.toString() || "").trim().split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  return fams.find((x) => x.includes(want)) || fams[0] || null;
}
function pickFont() {
  const local = rtl ? ["Tajawal-ExtraBold.ttf", "ExtraBold"] : ["Poppins-ExtraBold.ttf", "ExtraBold"];
  if (files.includes(local[0])) {
    const fam = familyOf(`fonts/${local[0]}`, local[1]);
    if (fam) return { name: fam, bold: false };
  }
  if (rtl) return { name: "DejaVu Sans", bold: true };
  const fc = spawnSync("fc-list", [":family=Poppins"]).stdout?.toString() || "";
  if (fc.trim()) return { name: "Poppins", bold: true };
  return { name: "DejaVu Sans", bold: true };
}
const font = pickFont();

// ---------- mesure EXACTE du texte (libass + bbox) ----------
// \fs d'ASS = hauteur de ligne complète : LF convertit une taille "visuelle" (em) en \fs.
function fontFile() {
  const local = rtl ? "Tajawal-ExtraBold.ttf" : "Poppins-ExtraBold.ttf";
  if (files.includes(local)) return `fonts/${local}`;
  const q = font.name.replace(" ExtraBold", "") + ":bold";
  const r = spawnSync("fc-match", ["-f", "%{file}", q]);
  return r.stdout?.toString().trim();
}
let LF = 1.4;
try {
  writeFileSync(`${CONTENT_DIR}/lf.txt`, "Mg");
  const r = spawnSync("python3", ["scripts/font-metrics.py", fontFile(), `${CONTENT_DIR}/lf.txt`], { maxBuffer: 1 << 24 });
  if (r.status === 0) LF = JSON.parse(r.stdout.toString()).lf || 1.4;
} catch {}
const nb = (t) => t.replace(/ +([?!:;»؟])/g, "\u00A0$1").replace(/(«) +/g, "$1\u00A0");
const tokensOf = (text) => nb(esc(text)).split(/ +/).filter(Boolean);
const allTokens = new Set(["●"]);
[plan.hook, ...plan.disclaimers, ...plan.beats.flatMap((b) => [b.headline, b.title, b.text, b.kicker, ...(b.points || [])]), ...tr.words.map((w) => w.w)]
  .filter(Boolean).forEach((t) => tokensOf(t).forEach((k) => allTokens.add(k)));
const TM = measureTokens({ tokens: [...allTokens], font, dir: CONTENT_DIR });
console.log(`Mesure du texte : ${TM.w.size} mots mesurés${TM.ok ? "" : " (⚠ mesure partielle, estimation utilisée)"}, espace = ${TM.space}px`);
const fs = (em) => Math.round(em * LF);
const tw = (str, em) => {
  const toks = tokensOf(str);
  const w = toks.reduce((n, t) => n + (TM.w.get(t) ?? t.length * TM.avg), 0) + Math.max(0, toks.length - 1) * TM.space;
  return (w * fs(em)) / 100;
};
function wrapPx(text, maxPx, em, maxLines = 99) {
  const words = tokensOf(text);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (tw(cur + " " + w, em) <= maxPx * 0.97) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length > maxLines ? null : lines;
}
// coupe proprement (dernier mot entier) pour tenir dans maxLines
function wrapClamp(text, maxPx, em, maxLines) {
  let words = tokensOf(text);
  for (;;) {
    const l = wrapPx(words.join(" "), maxPx, em, maxLines);
    if (l) return l;
    words = words.slice(0, -1);
    if (words.length < 3) return [words.join(" ")];
  }
}
const lh = (em) => em * LF; // pas de ligne en px
// mots les plus "forts" d'une phrase (les plus longs) : mis en couleur
const strip = (t) => t.replace(/[\p{P}\p{S}\u00A0]/gu, "");
const keyWords = (text, n) => {
  const seen = new Set();
  return tokensOf(text).map((t) => strip(t)).filter((t) => t.length >= 4 && !seen.has(t) && seen.add(t)).sort((a, b) => b.length - a.length).slice(0, n);
};
const colorize = (line, keys, hi, base) =>
  line.split(" ").map((t) => (keys.includes(strip(t)) && strip(t) ? `{${c1(hi)}}${t}{${c1(base)}}` : t)).join(" ");

// ---------- géométrie ----------
const even = (n) => Math.round(n / 2) * 2;
const mirror = (r) => (rtl ? { ...r, x: W - r.x - r.w } : r);
const mirrorW = (r) => (layoutRTL ? { ...r, x: W - r.x - r.w } : r);
function fit(box, a) {
  let w, h;
  if (box.w / box.h > a) { h = box.h; w = h * a; } else { w = box.w; h = w / a; }
  return { x: even(box.x + (box.w - w) / 2), y: even(box.y + (box.h - h) / 2), w: even(w), h: even(h) };
}
const L = vertical
  ? {
      logo: { x: 40, y: 190, w: 120, h: 120 }, banner: { x: 180, y: 170, w: 860, h: 200 },
      normalBox: { x: 40, y: 400, w: 1000, h: 1150 }, splitBox: { x: 40, y: 400, w: 520, h: 900 },
      panel: { x: 580, y: 400, w: 460, h: 900 }, subsY: 1520, subsSize: 74, subsPx: 940, subsWords: 4,
      ticker: { y: 1620, h: 54, size: 28 }, bannerMaxLines: 3, bannerSizes: [66, 58, 52, 46, 40, 34], titleSize: 44, bodySize: 31, hookSize: 80,
    }
  : {
      logo: { x: 44, y: 30, w: 120, h: 120 }, banner: { x: 190, y: 34, w: 1686, h: 128 },
      normalBox: { x: 320, y: 185, w: 1280, h: 720 }, splitBox: { x: 50, y: 185, w: 1130, h: 640 },
      panel: { x: 1210, y: 185, w: 660, h: 640 }, subsY: 1000, subsSize: 78, subsPx: 1560, subsWords: 5,
      ticker: { y: 1020, h: 54, size: 30 }, bannerMaxLines: 2, bannerSizes: [76, 66, 58, 52, 46, 40, 34], titleSize: 50, bodySize: 33, hookSize: 88,
    };
// Mise en page "shorts" (LAYOUT=shorts, vertical) : tout remonte pour rester HORS des zones couvertes par
// l'interface YouTube Shorts / TikTok / Reels (titre + description en bas ≈ 400 px, barre de recherche en haut).
if (vertical && process.env.LAYOUT === "shorts") {
  Object.assign(L, {
    logo: { x: 40, y: 150, w: 110, h: 110 }, banner: { x: 166, y: 135, w: 874, h: 190 },
    normalBox: { x: 40, y: 350, w: 1000, h: 1040 }, splitBox: { x: 40, y: 350, w: 520, h: 860 },
    panel: { x: 580, y: 350, w: 460, h: 860 }, subsY: 1360, ticker: { y: 1440, h: 50, size: 26 },
  });
  console.log("Mise en page : shorts (zones de sécurité des applis respectées)");
}
const logoR = mirror(L.logo);
const bannerR = (() => {
  // la bannière occupe la place restante à côté du logo
  const b = L.banner;
  return rtl ? { ...b, x: W - b.x - b.w } : b;
})();
const winNormal = fit(mirror(L.normalBox), srcAspect);
const panelR = mirrorW(L.panel);
const winSplitFinal = fit(mirrorW(L.splitBox), srcAspect);
// variations propres à la vidéo / au thème
L.subsSize = Math.round(L.subsSize * MV.subsScale);
L.subsY += Math.min(T.subsDy || 0, vertical ? 30 : 0);

// ---------- timeline des états : normal / split / punch ----------
const beats = plan.beats.filter((b) => b.t0 < D).map((b) => ({ ...b, t1: Math.min(b.t1, D) }));
const segs = [];
beats.forEach((b, i) => {
  const len = b.t1 - b.t0;
  const canSplit = len >= 7 && ((b.points && b.points.length) || (b.text && b.text.length > 10));
  const punch = i > 0 && i % 2 === 1 && len >= 4;
  let t = b.t0;
  if (punch) { segs.push({ t0: t, t1: t + 1.9, state: "punch", beat: i }); t += 1.9; }
  const splitStart = canSplit ? b.t0 + len * 0.42 : b.t1;
  if (splitStart > t) segs.push({ t0: t, t1: splitStart, state: "normal", beat: i });
  if (canSplit) segs.push({ t0: Math.max(splitStart, t), t1: b.t1, state: "split", beat: i });
});
if (segs.length) { segs[0].t0 = 0; segs[segs.length - 1].t1 = D; }
const merged = [];
for (const s of segs) {
  const last = merged[merged.length - 1];
  if (last && last.state === s.state && last.beat === s.beat) last.t1 = s.t1; else merged.push({ ...s });
}
const enableFor = (state) => {
  const parts = merged.filter((s) => s.state === state).map((s) => `between(t,${s.t0.toFixed(3)},${(s.t1 - 0.001).toFixed(3)})`);
  return parts.length ? parts.join("+") : "0";
};

// ---------- ASS ----------
const ass = new Ass(W, H, font.name, font.bold);

// ---- arabe : un événement PAR MOT ----
// libass range les blocs de couleur de gauche à droite et déplace donc les mots colorés en bout de ligne dans un
// texte arabe (testé : même avec des marques de direction Unicode). On place chaque mot nous-mêmes, avec les
// largeurs réelles mesurées, ce qui garde l'ordre de lecture exact.
const wordPx = (t, em) => ((TM.w.get(t) ?? t.length * TM.avg) * fs(em)) / 100;
const gapPx = (em) => (TM.space * fs(em)) / 100;
const lineW = (line, em) => {
  const toks = line.split(" ").filter(Boolean);
  return toks.reduce((n, t) => n + wordPx(t, em), 0) + Math.max(0, toks.length - 1) * gapPx(em);
};
function placeWords({ layer, t0, t1, line, em, edge, yc, keys, hi, base, tags, move, stagger = 0, fadeOut = 140 }) {
  // edge = bord droit de la ligne (arabe) ou bord gauche (autres langues)
  const toks = line.split(" ").filter(Boolean);
  let x = edge;
  toks.forEach((t, k) => {
    const w = wordPx(t, em);
    const xc = Math.round(rtl ? x - w / 2 : x + w / 2);
    const key = strip(t) !== "" && keys.includes(strip(t));
    const ts = Math.min(t1 - 0.1, t0 + k * stagger);
    const pos = move
      ? `\\move(${xc + move.dx},${Math.round(yc + move.dy)},${xc},${Math.round(yc)},0,${move.ms})`
      : `\\pos(${xc},${Math.round(yc)})`;
    const pop = stagger ? `\\fscx55\\fscy55\\t(0,140,\\fscx110\\fscy110)\\t(140,240,\\fscx100\\fscy100)` : "";
    ass.add(layer, ts, t1, `{\\an5${pos}${tags}${pop}${c1(key ? hi : base)}\\fad(${stagger ? 80 : 0},${fadeOut})}${t}`);
    x += (rtl ? -1 : 1) * (w + gapPx(em));
  });
}
const HOOK_END = plan.hook ? Math.min(3.3, D * 0.4) : 0.4;
const FULL = `m 0 0 l ${W} 0 l ${W} ${H} l 0 ${H}`;
const dirX = rtl ? -1 : 1; // sens de lecture / des balayages
const SUB_COLORS = [P.gold, P.cyan, "#FF7AB6", "#9DFF5C"];

// ---------- impulsions synchronisées avec la parole et les idées ----------
// À chaque nouvelle idée (début de séquence), mot-clé prononcé ou reprise de phrase après une pause : petit "coup"
// de zoom dans la fenêtre, flash de lumière sur le cadre et éclat sur le fond. Espacées d'au moins 1,4 s.
const ntok = (t) => String(t).replace(/[\p{P}\p{S}\u00A0]/gu, "").replace(/[\u064B-\u065F\u0670\u0640]/g, "").trim();
// niveau d'énergie : "high" (par défaut, nerveux), "normal" ou "low" — réglable via content/style.json {"energy":"normal"}
const energy = (() => {
  try {
    const st = existsSync(`${CONTENT_DIR}/style.json`) ? JSON.parse(readFileSync(`${CONTENT_DIR}/style.json`, "utf8")) : {};
    return String(process.env.ENERGY || st.energy || T.energy || "high").toLowerCase();
  } catch { return "high"; }
})();
const EN = {
  low: { gap: 1.4, idea: 0.1, kw: 0.055, sent: 0.035, long: 0, fill: 0, sweepEvery: 3, tick: false },
  normal: { gap: 1.0, idea: 0.12, kw: 0.065, sent: 0.045, long: 0, fill: 0, sweepEvery: 3, tick: false },
  high: { gap: 0.75, idea: 0.14, kw: 0.08, sent: 0.055, long: 0.045, fill: 0.032, sweepEvery: 2, tick: true },
}[energy] || null;
const E = EN || { gap: 0.75, idea: 0.14, kw: 0.08, sent: 0.055, long: 0.045, fill: 0.032, sweepEvery: 2, tick: true };
const pulses = (() => {
  const ev = [];
  beats.forEach((b) => { if (b.t0 > 0.3) ev.push({ t: b.t0, a: E.idea, b: E.idea * 1.6, idea: true }); });
  const kset = new Set(plan.keywords || []);
  const ws = tr.words.filter((w) => w.t0 < D - 0.3);
  ws.forEach((w, i) => {
    const gap = i ? w.t0 - ws[i - 1].t1 : 1;
    const tok = ntok(w.w);
    if (kset.has(tok)) ev.push({ t: w.t0, a: E.kw, b: E.kw * 1.45, kw: true });
    else if (i && gap >= 0.45) ev.push({ t: w.t0, a: E.sent, b: E.sent * 1.3 });
    else if (E.long && tok.length >= 7) ev.push({ t: w.t0, a: E.long, b: E.long * 1.3 });
  });
  ev.sort((x, y) => x.t - y.t);
  const out = [];
  for (const e of ev) {
    const last = out[out.length - 1];
    if (last && e.t - last.t < E.gap) { if ((e.idea && !last.idea) || (e.a > last.a * 1.4 && e.t - last.t > E.gap * 0.5)) out[out.length - 1] = e; continue; }
    out.push(e);
  }
  // remplissage : jamais plus de 2 s sans mouvement (mode nerveux)
  if (E.fill) {
    const filled = [];
    for (let i = 0; i < out.length; i++) {
      filled.push(out[i]);
      const next = out[i + 1] ? out[i + 1].t : D;
      for (let t = out[i].t + 2.0; t < next - 0.9; t += 2.0) filled.push({ t, a: E.fill, b: E.fill * 1.3 });
    }
    out.length = 0; out.push(...filled);
  }
  return out.slice(0, 320);
})();
const pulseExpr = (T, key, k) => pulses.map((e) => `if(gte(${T},${e.t.toFixed(3)}),${e[key].toFixed(3)}*exp(-${k}*(${T}-${e.t.toFixed(3)})),0)`).join("+") || "0";
console.log(`Impulsions synchronisées : ${pulses.length} (zoom + lumière, énergie « ${energy} »)`);
// 1) barre de progression
const pbY = T.progress === "top" ? 0 : H - 8;
ass.shape(2, 0, D, 0, pbY, `m 0 0 l ${W} 0 l ${W} 8 l 0 8`, c1(P.white, 0.3));
ass.shape(3, 0, D, rtl ? W : 0, pbY, `m 0 0 l ${W} 0 l ${W} 8 l 0 8`,
  `${c1(P.gold)}${rtl ? "\\an9" : ""}\\fscx1\\t(0,${Math.round(D * 1000)},\\fscx100)`);

// 2) fenêtre vidéo : halo qui "respire" + cadre fin, par segment
const winFor = (state) => (state === "split" ? winSplitFinal : winNormal);
pulses.forEach((e, k) => {
  const seg = merged.find((m) => e.t >= m.t0 && e.t < m.t1);
  if (!seg) return;
  const w = winFor(seg.state);
  ass.shape(5, e.t, e.t + 0.45, w.x, w.y, rrect(w.w, w.h, T.radius), `\\1a&HFF&${c3(e.idea ? P.gold : P.white, 0.7)}\\bord${Math.round((e.idea ? 30 : 18) * MV.flareScale)}\\blur14\\fad(0,380)`);
  if (k % E.sweepEvery === 0 && e.t + 0.9 < D) {
    // balayage de lumière douce sur toute l'image
    const x0 = rtl ? W + 220 : -220, x1 = rtl ? -220 : W + 220;
    ass.add(0, e.t, e.t + 0.9, `{\\an7\\move(${x0},0,${x1},0,0,850)\\bord0\\shad0\\blur30${c1(P.white, e.idea ? 0.16 : 0.1)}\\p1}m 0 0 l ${dirX * 170} 0 l ${dirX * 110} ${H} l ${dirX * -60} ${H}{\\p0}`);
  }
});

for (const s of merged) {
  const w = winFor(s.state);
  const glow = s.state === "punch" ? P.gold : P.cyan;
  const pulse = `\\t(0,500,\\bord24\\blur20)\\t(500,1000,\\bord14\\blur12)\\t(1000,1500,\\bord24\\blur20)\\t(1500,2000,\\bord14\\blur12)`;
  ass.shape(1, s.t0, s.t1, w.x, w.y, rrect(w.w, w.h, T.radius), `\\1a&HFF&${c3(glow, 0.6)}\\bord14\\blur12\\fad(120,0)${pulse}`);
  ass.shape(4, s.t0, s.t1, w.x, w.y, rrect(w.w, w.h, T.radius), `\\1a&HFF&${c3(T.frame === "accent" ? P.accent : T.frame === "gold" ? P.gold : P.white, 0.95)}\\bord4\\blur0.6\\fad(120,0)`);
}

// 3) transitions (type selon le thème) : "bands" = flash + bandes ; "wipe" = rideau de couleur ; "flash2" = double flash
merged.forEach((s, i) => {
  if (i === 0) return;
  const x0 = rtl ? W + 320 : -320, x1 = rtl ? -320 : W + 320;
  const band = (wd, sk) => `m 0 0 l ${dirX * wd} 0 l ${dirX * (wd - sk)} ${H} l ${dirX * -sk} ${H}`;
  if (T.transition === "wipe") {
    // le rideau couvre l'écran pile à l'instant du changement de plan
    const a = Math.max(0, s.t0 - 0.23);
    const cw = W + 260;
    const xs = rtl ? W + 60 : -cw - 60, xe = rtl ? -cw - 60 : W + 60;
    ass.add(9, a, a + 0.5, `{\\an7\\move(${xs},0,${xe},0,0,460)\\bord0\\shad0${c1(P.accent, 0.96)}\\p1}m 0 0 l ${cw} 0 l ${cw} ${H} l 0 ${H}{\\p0}`);
    ass.add(9, a + 0.06, a + 0.54, `{\\an7\\move(${xs},0,${xe},0,0,460)\\bord0\\shad0${c1(P.cyan, 0.9)}\\p1}m 0 0 l ${cw - 90} 0 l ${cw - 90} ${H} l 0 ${H}{\\p0}`);
  } else if (T.transition === "flash2") {
    ass.shape(9, s.t0, s.t0 + 0.26, 0, 0, FULL, `${c1(P.white, 0.45)}\\t(0,240,\\1a&HFF&)`);
    ass.shape(9, s.t0 + 0.14, s.t0 + 0.42, 0, 0, FULL, `${c1(P.accent, 0.4)}\\t(0,260,\\1a&HFF&)`);
  } else {
    ass.shape(9, s.t0, s.t0 + 0.28, 0, 0, FULL, `${c1(P.white, 0.4)}\\t(0,260,\\1a&HFF&)`);
    ass.add(9, s.t0, s.t0 + 0.46, `{\\an7\\move(${x0},0,${x1},0,0,440)\\bord0\\shad0${c1(P.accent, 0.9)}\\p1}${band(240, 220)}{\\p0}`);
    ass.add(9, s.t0 + 0.07, s.t0 + 0.5, `{\\an7\\move(${x0},0,${x1},0,0,440)\\bord0\\shad0${c1(P.cyan, 0.85)}\\p1}${band(110, 220)}{\\p0}`);
  }
});

// 4) logo (cadre accent)
ass.shape(5, 0, D, logoR.x, logoR.y, rrect(L.logo.w, L.logo.h, 26), `\\1a&HFF&${c3(P.accent)}\\bord6\\blur0.4`);

// 5) bandeau de headline : révélation par balayage + reflet + mot-clé en couleur
function fitBanner(text) {
  const maxW = bannerR.w - 80;
  for (const em of L.bannerSizes) {
    const lines = wrapPx(text, maxW, em, L.bannerMaxLines);
    if (lines && lines.length * lh(em) <= bannerR.h - 16) return { lines, em };
  }
  const em = L.bannerSizes[L.bannerSizes.length - 1];
  return { lines: wrapClamp(text, maxW, em, L.bannerMaxLines), em };
}
beats.forEach((b, i) => {
  if (!b.headline) return;
  const start = i === 0 ? HOOK_END - 0.2 : b.t0;
  const end = b.t1;
  if (end - start < 0.4) return;
  const { lines, em } = fitBanner(b.headline);
  const bx = bannerR.x, by = bannerR.y, bw = bannerR.w, bh = bannerR.h;
  const clipFrom = rtl ? `\\clip(${bx + bw},${by},${bx + bw},${by + bh})` : `\\clip(${bx},${by},${bx},${by + bh})`;
  const wipe = (d0, d1) => `${clipFrom}\\t(${d0},${d1},\\clip(${bx},${by},${bx + bw},${by + bh}))`;
  ass.add(2, start, end, `{\\an7\\pos(${bx},${by})\\bord0\\shad0${c1(P.dark, 0.93)}${wipe(0, 380)}\\fad(0,140)\\p1}${rrect(bw, bh, 22)}{\\p0}`);
  const barX = rtl ? bx + bw - 14 : bx;
  ass.add(3, start, end, `{\\an7\\pos(${barX},${by})\\bord0\\shad0${c1(P.accent)}${wipe(60, 440)}\\fad(0,140)\\p1}${rrect(14, bh, 7)}{\\p0}`);
  const tx = rtl ? bx + bw - 40 : bx + 40;
  const ty = by + bh / 2;
  const keys = keyWords(b.headline, 1);
  lines.forEach((ln, k) => placeWords({ layer: 6, t0: start + 0.12, t1: end, line: ln, em, edge: tx, yc: ty + (k - (lines.length - 1) / 2) * lh(em), keys, hi: P.gold, base: P.white, tags: `\\fs${fs(em)}\\bord0\\shad2${c4(P.black, 0.6)}`, stagger: 0.07 }));
  // reflet blanc qui traverse le bandeau
  const sx0 = rtl ? bx + bw + 80 : bx - 80, sx1 = rtl ? bx - 80 : bx + bw + 80;
  ass.add(7, start + 0.3, start + 0.95,
    `{\\an7\\move(${sx0},${by - 6},${sx1},${by - 6})\\clip(${bx},${by},${bx + bw},${by + bh})\\bord0\\shad0${c1(P.white, 0.2)}\\p1}m 0 0 l ${dirX * 70} 0 l ${dirX * 20} ${bh + 12} l ${dirX * -50} ${bh + 12}{\\p0}`);
});

// 6) cartes d'analyse en split-screen : texte qui entre ligne par ligne, mots clés en or
const emojiHex = (e) => [...(e || "")].map((c) => c.codePointAt(0).toString(16)).join("-");
const emojiFile = (e) => `assets/emoji/${emojiHex(e)}.png`;
const emojiOverlays = []; // {file, kind, t0, t1, x, y, size}
merged.filter((s) => s.state === "split").forEach((s) => {
  const b = beats[s.beat];
  const p = panelR;
  const t0 = s.t0 + 0.12, t1 = s.t1;
  const slide = layoutRTL ? -90 : 90;
  const pad = 30;
  ass.add(1, t0, t1, `{\\an7\\move(${p.x + slide},${p.y},${p.x},${p.y},0,300)\\bord5${c3(P.cyan)}${c1(P.card, 0.94)}\\shad0\\fad(220,160)\\p1}${rrect(p.w, p.h, 28)}{\\p0}`);
  // liseré supérieur coloré qui grandit
  ass.add(2, t0 + 0.1, t1, `{\\an${rtl ? 9 : 7}\\pos(${rtl ? p.x + p.w - pad : p.x + pad},${p.y + 14})\\bord0\\shad0${c1(P.accent)}\\fscx2\\t(0,500,\\fscx100)\\fad(100,160)\\p1}${rrect(p.w - pad * 2 - 110, 6, 3)}{\\p0}`);
  const innerW = p.w - pad * 2;
  const tx = rtl ? p.x + p.w - pad : p.x + pad;
  const an = rtl ? 9 : 7;
  let y = p.y + 30;
  const iconSize = 84;
  emojiOverlays.push({ file: emojiFile(b.emoji), kind: "card", t0, t1, x: rtl ? p.x + pad : p.x + p.w - pad - iconSize, y: p.y + 24, size: iconSize });
  // kicker (pastille)
  const kEm = vertical ? 28 : 30;
  const kicker = esc(b.kicker || "");
  const pillH = lh(kEm) * 0.72 + 16;
  const kW = Math.min(innerW - iconSize - 12, tw(kicker, kEm) + 44);
  const kx = rtl ? p.x + p.w - pad - kW : p.x + pad;
  ass.add(2, t0, t1, `{\\an7\\move(${kx + slide},${y},${kx},${y},0,300)\\bord0\\shad0${c1(P.accent)}\\fad(220,160)\\p1}${rrect(kW, pillH, T.pill === "square" ? 8 : pillH / 2)}{\\p0}`);
  ass.add(3, t0, t1, `{\\an5\\move(${kx + kW / 2 + slide},${y + pillH / 2},${kx + kW / 2},${y + pillH / 2},0,300)\\fs${fs(kEm)}\\bord0\\shad0${c1(P.white)}\\fad(220,160)}${kicker}`);
  y += pillH + 26;

  // contenu (titre + corps) : on choisit la plus grande taille qui tient, puis on centre le bloc
  const availBottom = p.y + p.h - 34;
  const titleTxt = (b.title || "").trim();
  const hasTitle = titleTxt && titleTxt !== (b.headline || "").trim();
  let tEm = L.titleSize, tLines = [];
  if (hasTitle) {
    tLines = wrapPx(titleTxt, innerW, tEm, 3);
    if (!tLines) { tEm = Math.round(tEm * 0.84); tLines = wrapClamp(titleTxt, innerW, tEm, 3); }
  }
  const titleH = tLines.length ? tLines.length * lh(tEm) + 14 : 0;
  const sepH = 30;
  const room = availBottom - y - titleH - sepH;
  const pts = b.points && b.points.length ? b.points : null;
  const bulletW = 46;
  const BUL = { dot: "m 12 0 b 19 0 24 5 24 12 b 24 19 19 24 12 24 b 5 24 0 19 0 12 b 0 5 5 0 12 0", square: "m 3 3 l 21 3 l 21 21 l 3 21", arrow: "m 2 3 l 22 12 l 2 21" }[T.bullet] || "m 12 0 b 19 0 24 5 24 12 b 24 19 19 24 12 24 b 5 24 0 19 0 12 b 0 5 5 0 12 0";
  let bEm = vertical ? 54 : 46;
  const layout = (em) => (pts ? pts.map((pt) => wrapPx(pt, innerW - bulletW, em)) : [wrapPx(b.text, innerW, em)]);
  const heightOf = (gs, em) => gs.reduce((n, l) => n + l.length, 0) * lh(em) * 1.06 + (pts ? (gs.length - 1) * lh(em) * 0.5 : 0);
  let groups = layout(bEm);
  while (heightOf(groups, bEm) > room && bEm > 26) { bEm -= 1; groups = layout(bEm); }
  if (heightOf(groups, bEm) > room) {
    if (pts) { while (groups.length > 2 && heightOf(groups, bEm) > room) groups.pop(); }
    else groups = [wrapClamp(b.text, innerW, bEm, Math.max(2, Math.floor(room / (lh(bEm) * 1.06))))];
  }
  y += Math.max(0, (room - heightOf(groups, bEm)) * 0.35);

  if (tLines.length) {
    ass.add(3, t0 + 0.1, t1, `{\\an${an}\\move(${tx + slide},${y},${tx},${y},0,320)\\fs${fs(tEm)}\\bord0\\shad2${c4(P.black, 0.6)}${c1(P.gold)}\\fad(260,160)}${tLines.join("\\N")}`);
    y += titleH;
  }
  ass.add(2, t0 + 0.2, t1, `{\\an7\\pos(${rtl ? tx - 90 : tx},${y})\\bord0\\shad0${c1(P.accent)}\\fscx2\\t(0,420,\\fscx100)\\fad(100,160)\\p1}${rrect(90, 6, 3)}{\\p0}`);
  y += sepH;
  const keys = keyWords(pts ? pts.join(" ") : b.text, 4);
  const lineH = lh(bEm) * 1.06;
  const step = Math.min(0.24, Math.max(0.08, (t1 - t0 - 1.2) / Math.max(1, groups[0].length)));
  const textX = pts ? (rtl ? tx - bulletW : tx + bulletW) : tx;
  let ly = y;
  groups.forEach((lines, gi) => {
    const gStart = t0 + 0.45 + gi * Math.min(0.6, Math.max(0.2, (t1 - t0 - 1.4) / groups.length));
    if (pts && gStart < t1 - 0.2) {
      const cx = rtl ? tx - 13 : tx + 13, cy = ly + lh(bEm) * 0.5;
      ass.add(3, gStart, t1, `{\\an7\\pos(${cx - 12},${cy - 12})\\bord0\\shad0${c1(P.gold)}\\fscx0\\fscy0\\t(0,220,\\fscx100\\fscy100)\\fad(0,160)\\p1}${BUL}{\\p0}`);
    }
    lines.forEach((ln, k) => {
      const yy = ly + k * lineH;
      const ls = pts ? gStart + k * 0.07 : t0 + 0.45 + k * step;
      if (ls >= t1 - 0.2) return;
      placeWords({ layer: 3, t0: ls, t1, line: ln, em: bEm, edge: textX, yc: yy + lh(bEm) / 2, keys, hi: P.gold, base: P.white, tags: `\\fs${fs(bEm)}\\bord0\\shad1${c4(P.black, 0.5)}`, move: { dx: rtl ? -40 : 40, dy: 12, ms: 240 }, stagger: 0.045, fadeOut: 160 });
    });
    ly += lines.length * lineH + (pts ? lh(bEm) * 0.5 : 0);
  });

  // flèche pulsante qui relie la carte à la vidéo
  const w = winSplitFinal;
  const ax = layoutRTL ? w.x - 4 : w.x + w.w + 4;
  const ay = w.y + w.h / 2;
  const dir = layoutRTL ? 1 : -1; // pointe vers la vidéo
  const arrow = `m 0 0 l ${-dir * 24} ${-27} l ${-dir * 24} ${-11} l ${-dir * 40} ${-11} l ${-dir * 40} ${11} l ${-dir * 24} ${11} l ${-dir * 24} ${27}`;
  ass.add(8, t0 + 0.2, t1, `{\\an7\\pos(${ax},${ay})\\bord2${c3(P.dark)}\\shad0${c1(P.accent)}\\fad(200,150)\\t(0,500,\\fscx125\\fscy125)\\t(500,1000,\\fscx100\\fscy100)\\t(1000,1500,\\fscx125\\fscy125)\\t(1500,2000,\\fscx100\\fscy100)\\p1}${arrow}{\\p0}`);
});

// 7) hook d'ouverture (absent si aucune IA n'a pu l'écrire)
if (plan.hook) {
  const t0 = 0.15, t1 = HOOK_END;
  const box = winNormal;
  const hw = Math.min(box.w * 0.92, vertical ? 940 : 1200);
  let em = L.hookSize;
  let lines = wrapPx(plan.hook, hw - 90, em, 4);
  if (!lines) { em = Math.round(em * 0.8); lines = wrapClamp(plan.hook, hw - 90, em, 4); }
  const hh = lines.length * lh(em) + 64;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ass.add(7, t0, t1, `{\\an7\\pos(${cx - hw / 2},${cy - hh / 2})\\bord6${c3(P.gold)}${c1(P.dark, 0.92)}\\shad0\\fad(150,260)\\t(0,300,\\bord10)\\t(300,600,\\bord6)\\p1}${rrect(hw, hh, 34)}{\\p0}`);
  const keys = keyWords(plan.hook, 1);
  lines.forEach((ln, k) => placeWords({ layer: 8, t0, t1, line: ln, em, edge: rtl ? cx + lineW(ln, em) / 2 : cx - lineW(ln, em) / 2, yc: cy + (k - (lines.length - 1) / 2) * lh(em), keys, hi: P.gold, base: P.white, tags: `\\fs${fs(em)}\\bord0\\shad3${c4(P.black, 0.7)}`, stagger: 0.09, fadeOut: 260 }));
  emojiOverlays.push({ file: emojiFile(plan.hookEmoji), kind: "hook", t0, t1, x: cx - 80, y: cy - hh / 2 - 150, size: 160 });
}

// stickers emoji (coin de la fenêtre) + petits emojis qui montent
merged.filter((s) => s.state !== "split").forEach((s) => {
  const b = beats[s.beat];
  if (s.t0 < HOOK_END) return;
  const w = winNormal;
  const size = vertical ? 130 : 140;
  emojiOverlays.push({
    file: emojiFile(b.emoji), kind: "sticker", t0: s.t0 + 0.2, t1: Math.min(s.t1, s.t0 + 3.6),
    x: layoutRTL ? w.x - size * 0.35 : w.x + w.w - size * 0.65, y: w.y - size * 0.45, size,
  });
  [0, 1].forEach((k) => {
    emojiOverlays.push({
      file: emojiFile(b.emoji), kind: "float", t0: s.t0 + 0.5 + k * 0.45, t1: Math.min(s.t1, s.t0 + 0.5 + k * 0.45 + 2.2),
      x: (k ? w.x + w.w * 0.18 : w.x + w.w * 0.78), y: w.y + w.h - 150, size: 78,
    });
  });
});

const style = (() => {
  try { return existsSync(`${CONTENT_DIR}/style.json`) ? JSON.parse(readFileSync(`${CONTENT_DIR}/style.json`, "utf8")) : {}; }
  catch (e) { console.log(`⚠ content/style.json illisible (${e.message}) : réglages par défaut.`); return {}; }
})();
const subMode = String(process.env.SUBTITLES || style.subtitles || "full").toLowerCase(); // full | keywords | off
const normTok = (t) => String(t).replace(/[\p{P}\p{S}\u00A0]/gu, "").replace(/[\u064B-\u065F\u0670\u0640]/g, "").trim();
console.log(`Sous-titres : mode « ${subMode} »`);
// 8) sous-titres dynamiques mot à mot : pop, légère inclinaison, couleur qui change à chaque phrase
if (subMode === "keywords") {
  // mode mots-clés : seuls les mots importants apparaissent, en grand, au moment où le locuteur les prononce
  const kset = new Set(plan.keywords || []);
  const evs = [];
  let ci = 0;
  for (const w of tr.words.filter((x) => x.t0 < D)) {
    if (!kset.has(normTok(w.w))) continue;
    ci++;
    const em = L.subsSize * 1.5;
    evs.push({ t0: w.t0, t1: Math.max(w.t1, w.t0 + 1.0), text: `{\\an5\\pos(${W / 2},${L.subsY - 40})\\frz${ci % 2 ? -4 : 4}\\fs${fs(em)}\\fscx60\\fscy60\\t(0,100,\\fscx118\\fscy118)\\t(100,200,\\fscx100\\fscy100)\\bord9${c3(P.black)}\\shad4${c4(P.black, 0.6)}${c1(SUB_COLORS[ci % SUB_COLORS.length])}\\fad(0,120)}${esc(w.w)}` });
  }
  for (let k = 1; k < evs.length; k++) {
    const a = evs[k - 1], b = evs[k];
    if (b.t0 < a.t1) a.t1 = Math.max(a.t0 + 0.08, b.t0);
  }
  evs.forEach((e) => (e.texts || [e.text]).forEach((tx) => ass.add(10, e.t0, e.t1, tx)));
} else if (subMode !== "off") {
  const words = tr.words.filter((w) => w.t0 < D);
  const phrases = [];
  let cur = [];
  const flush = () => { if (cur.length) phrases.push(cur); cur = []; };
  for (const w of words) {
    const gap = cur.length ? w.t0 - cur[cur.length - 1].t1 : 0;
    const wide = tw([...cur, w].map((x) => x.w).join(" "), L.subsSize * 1.14);
    if (cur.length && (cur.length >= L.subsWords || wide > L.subsPx || gap > 0.55)) flush();
    cur.push(w);
    if (/[.!?؟…]$/.test(w.w) && cur.length >= 2) flush();
  }
  flush();
  const cx = W / 2;
  const evs = [];
  phrases.forEach((ph, pi) => {
    const nextStart = pi < phrases.length - 1 ? phrases[pi + 1][0].t0 - 0.05 : Infinity;
    const prevEnd = pi > 0 ? phrases[pi - 1][phrases[pi - 1].length - 1].t1 + 0.02 : 0;
    const hi = SUB_COLORS[pi % SUB_COLORS.length];
    const tilt = T.tilt ? (pi % 2 ? 2 : -2) : 0;
    ph.forEach((w, i) => {
      const t0 = i === 0 ? Math.max(prevEnd, w.t0 - 0.05) : w.t0;
      let t1 = i < ph.length - 1 ? ph[i + 1].t0 : Math.min(w.t1 + 0.18, nextStart);
      if (t1 - t0 < 0.12) t1 = t0 + 0.12;
      let texts;
      if (rtl) {
        // arabe : un événement par mot (voir rtlWords), mot actif en couleur et agrandi
        const toks = ph.map((x) => esc(x.w));
        const em = L.subsSize;
        const total = toks.reduce((n, t) => n + wordPx(t, em), 0) + (toks.length - 1) * gapPx(em);
        let xr = cx + total / 2;
        const yc = Math.round(L.subsY - lh(em) / 2);
        texts = toks.map((t, j) => {
          const w = wordPx(t, em);
          const xc = Math.round(xr - w / 2);
          xr -= w + gapPx(em);
          const act = j === i;
          const sc = act ? 114 : 100;
          let popT = i === 0 ? `\\fscx70\\fscy70\\t(0,90,\\fscx118\\fscy118)\\t(90,170,\\fscx${sc}\\fscy${sc})` : `\\fscx${sc}\\fscy${sc}`;
          let posT = `\\pos(${xc},${yc})`;
          if (i === 0 && T.subAnim === "drop") popT = `\\fscx140\\fscy140\\t(0,130,\\fscx${sc}\\fscy${sc})`;
          if (i === 0 && T.subAnim === "slide") { popT = `\\fscx${sc}\\fscy${sc}`; posT = `\\move(${xc},${yc + 34},${xc},${yc},0,130)`; }
          return `{\\an5${posT}\\fs${fs(em)}${popT}\\bord${vertical ? 8 : 7}${c3(P.black)}\\shad3${c4(P.black, 0.6)}${c1(act ? hi : P.white)}}${t}`;
        });
      } else {
        const line = ph.map((x, j) => {
          const wd = esc(x.w);
          return j === i ? `{${c1(hi)}\\fscx114\\fscy114}${wd}{${c1(P.white)}\\fscx100\\fscy100}` : wd;
        }).join(" ");
        let pop = i === 0 ? "\\fscx70\\fscy70\\t(0,90,\\fscx116\\fscy116)\\t(90,170,\\fscx100\\fscy100)" : "";
        let posL = `\\pos(${cx},${L.subsY})`;
        if (i === 0 && T.subAnim === "drop") pop = "\\fscx140\\fscy140\\t(0,130,\\fscx100\\fscy100)";
        if (i === 0 && T.subAnim === "slide") posL = `\\move(${cx},${L.subsY + 34},${cx},${L.subsY},0,130)`;
        texts = [`{\\an2${posL}\\frz${tilt}\\fs${fs(L.subsSize)}${pop}\\bord${vertical ? 8 : 7}${c3(P.black)}\\shad3${c4(P.black, 0.6)}${c1(P.white)}}${line}`];
      }
      evs.push({ t0, t1, texts });
    });
  });
  // jamais deux sous-titres en même temps (les horodatages de la transcription se chevauchent parfois)
  for (let k = 1; k < evs.length; k++) {
    const a = evs[k - 1], b = evs[k];
    if (b.t0 < a.t1) {
      if (b.t0 - a.t0 >= 0.06) a.t1 = b.t0;
      else { b.t0 = a.t0 + 0.06; a.t1 = b.t0; }
      if (b.t1 <= b.t0) b.t1 = b.t0 + 0.1;
    }
  }
  evs.forEach((e) => (e.texts || [e.text]).forEach((tx) => ass.add(10, e.t0, e.t1, tx)));
}

// 9) ticker de disclaimers permanent : défilement continu SANS trou (largeur mesurée exactement)
{
  const tk = L.ticker;
  const mid = tk.y + tk.h / 2 + 1;
  ass.shape(11, 0, D, 0, tk.y, `m 0 0 l ${W} 0 l ${W} ${tk.h} l 0 ${tk.h}`, c1(P.dark, 0.9));
  ass.shape(11, 0, D, 0, tk.y, `m 0 0 l ${W} 0 l ${W} 3 l 0 3`, c1(P.accent));
  const full = plan.disclaimers.map((t) => esc(lang === "ar" ? t : t.toUpperCase()).replace(/ +/g, " ")).join(" ● ") + " ●";
  const exact = measureLine({ text: full, fs: fs(tk.size), font, dir: CONTENT_DIR });
  const textW = Math.round((exact || tw(full, tk.size)) * 1.01) + 8;
  console.log(`Ticker : largeur ${textW}px (${exact ? "mesurée" : "estimée"})`);
  const gap = 140;
  const speed = 150;
  const cycle = (textW + gap) / speed;
  const dur = (W + textW) / speed;
  for (let start = 0; start < D; start += cycle) {
    ass.add(12, start, Math.min(D, start + dur),
      `{\\an4\\move(${W},${mid},${-textW},${mid})\\clip(0,${tk.y},${W},${tk.y + tk.h})\\fs${fs(tk.size)}\\bord0\\shad0${c1(P.white)}}${full}`);
  }
}

// ---------- effets sonores synthétiques ----------
mkdirSync("assets/sfx", { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });
function synth(name, src) {
  const out = `assets/sfx/${name}.wav`;
  if (existsSync(out)) return out;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", src, "-ar", "48000", "-ac", "2", out]);
  return out;
}
const SV = [
  { w: [500, 7000, 9], p: 880, d: 1320, i: 62 },
  { w: [300, 5000, 6], p: 660, d: 988, i: 55 },
  { w: [800, 9000, 14], p: 1046, d: 1568, i: 70 },
  { w: [400, 4000, 4], p: 740, d: 1174, i: 48 },
][Math.abs(T.sfx || 0) % 4];
const vn = `v${Math.abs(T.sfx || 0) % 4}`;
const SFX = {
  whoosh: synth(`whoosh-${vn}`, `anoisesrc=d=0.55:c=pink:r=48000:a=0.9,highpass=f=${SV.w[0]},lowpass=f=${SV.w[1]},afade=t=in:d=0.22,afade=t=out:st=0.2:d=0.35,tremolo=f=${SV.w[2]}:d=0.5`),
  pop: synth(`pop-${vn}`, `sine=f=${SV.p}:d=0.16:r=48000,afade=t=out:st=0.02:d=0.14,volume=1.2`),
  ding: synth(`ding-${vn}`, `sine=f=${SV.d}:d=0.55:r=48000,aecho=0.7:0.6:60:0.4,afade=t=out:st=0.05:d=0.5`),
  impact: synth(`impact-${vn}`, `sine=f=${SV.i}:d=0.7:r=48000,afade=t=out:st=0.05:d=0.65,volume=2.2`),
};
const sfxEvents = [{ type: "impact", t: 0.1, v: 0.9 }];
beats.forEach((b, i) => { if (i > 0 || b.t0 + 0.2 >= HOOK_END) sfxEvents.push({ type: "ding", t: Math.max(b.t0, HOOK_END - 0.2), v: 0.35 }); });
merged.forEach((s, i) => { if (i > 0) sfxEvents.push({ type: "whoosh", t: s.t0, v: 0.55 }); });
emojiOverlays.filter((e) => e.kind === "sticker").forEach((e) => sfxEvents.push({ type: "pop", t: e.t0, v: 0.5 }));
if (E.tick) pulses.filter((e) => e.kw).slice(0, 120).forEach((e) => sfxEvents.push({ type: "pop", t: e.t, v: 0.16 }));

// ---------- masques arrondis (une image fixe, générée par ffmpeg) ----------
function mask(name, w, h, r) {
  const out = `assets/mask-${name}-${w}x${h}-r${r}.png`;
  if (existsSync(out)) return out;
  const ix = `max(max(${r}-X,X-(${w - 1}-${r})),0)`;
  const iy = `max(max(${r}-Y,Y-(${h - 1}-${r})),0)`;
  const expr = `clip(255*(${r}-sqrt(pow(${ix},2)+pow(${iy},2)))+128,0,255)`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=white:s=${w}x${h}:d=1,format=gray,geq=lum='${expr}'`, "-frames:v", "1", out]);
  return out;
}
const mNormal = mask("n", winNormal.w, winNormal.h, T.radius);
const mSplit = mask("s", winSplitFinal.w, winSplitFinal.h, T.radius);
const mLogo = mask("l", L.logo.w, L.logo.h, 26);

// ---------- emojis disponibles ----------
const usableEmoji = emojiOverlays.filter((e) => existsSync(e.file));

// ---------- fichiers de sortie intermédiaires ----------
writeFileSync(`${CONTENT_DIR}/video.ass`, ass.toString());

// ---------- logo selon la langue : FR (et EN/IT par défaut) ou AR ----------
const logoFile = [`input/logo-${lang === "ar" ? "ar" : "fr"}.png`, "input/logo.png", "input/logo-fr.png"].find(existsSync);

// ---------- graphe de filtres ----------
const hasAudio = info.hasAudio;
const inputs = [];
const addInput = (args) => { inputs.push(...args); return inputs.filter((a) => a === "-i").length - 1; };
const iSrc = addInput(["-i", videoPath]);
const iLogo = logoFile ? addInput(["-loop", "1", "-framerate", String(FPS), "-i", logoFile]) : -1;
const iMN = addInput(["-loop", "1", "-framerate", String(FPS), "-i", mNormal]);
const iMS = addInput(["-loop", "1", "-framerate", String(FPS), "-i", mSplit]);
const iML = addInput(["-loop", "1", "-framerate", String(FPS), "-i", mLogo]);
const sfxIdx = {};
for (const [k, f] of Object.entries(SFX)) sfxIdx[k] = addInput(["-i", f]);
// chaque emoji n'est décodé QUE pendant sa fenêtre d'affichage (-t + décalage des timestamps) : bien plus rapide
// que des images en boucle sur toute la durée de la vidéo.
const emojiIdx = usableEmoji.map((e) => addInput(["-loop", "1", "-framerate", String(FPS), "-t", Math.max(0.2, e.t1 - e.t0 + 0.1).toFixed(3), "-i", e.file]));

const f = [];
const bw = even(W / 8), bh = even(H / 8);
const gw = even(W / 6), gh = even(H / 6);
const hasPunch = merged.some((s) => s.state === "punch");
f.push(`[${iSrc}:v]setpts=PTS-STARTPTS,fps=${FPS},setsar=1${padSec > 0.5 ? `,tpad=stop_mode=clone:stop_duration=${(padSec + 1).toFixed(2)}` : ""},split=${hasPunch ? 4 : 3}[bgs][nv0][sv0]${hasPunch ? "[pv0]" : ""}`);
// fond : copie floutée + dérive de teinte + dégradé animé (basse résolution = rapide)
f.push(`[bgs]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=5,eq=brightness='${MV.bgDark}+${pulseExpr("t", "b", 6)}':saturation=${T.sat}:eval=frame,hue=h='${T.hueSpeed}*t+${MV.hueOffset % 50}':s=1.15,scale=${W}:${H}:flags=bicubic,format=yuv420p[bg0]`);
f.push(`gradients=size=${gw}x${gh}:rate=${FPS}:duration=${D.toFixed(3)}:${GRAD.map((c, i) => `c${i}=0x${c}`).join(":")}:nb_colors=${GRAD.length}:speed=${MV.gradSpeed},scale=${W}:${H}:flags=bicubic,format=yuv420p[grad]`);
f.push(`[bg0][grad]blend=all_mode=overlay:all_opacity=0.5[bg]`);
f.push(`[${iMN}:v]format=gray,split=${hasPunch ? 2 : 1}${hasPunch ? "[mn1][mn2]" : "[mn1]"}`);
// travelling lent dans la fenêtre : la vidéo "vit" même quand le plan est fixe
// zoompan : travelling lent + "coups" de zoom synchronisés (T = temps de la sortie, d=1 : une image en entrée = une en sortie)
const ZP = pulseExpr(`on/${FPS}`, "a", 7);
const kb = (w, h, base) =>
  `scale=${even(w * 1.5)}:${even(h * 1.5)},zoompan=z='${base}+${ZP}':x='(iw-iw/zoom)/2*(1+0.9*sin(on/${FPS}*0.55))':y='(ih-ih/zoom)/2*(1+0.9*cos(on/${FPS}*0.42))':d=1:s=${w}x${h}:fps=${FPS},format=yuva420p`;
f.push(`[nv0]${kb(winNormal.w, winNormal.h, 1.12)}[nv1]`);
f.push(`[nv1][mn1]alphamerge[nv]`);
f.push(`[sv0]${kb(winSplitFinal.w, winSplitFinal.h, 1.12)}[sv1]`);
f.push(`[${iMS}:v]format=gray[ms]`);
f.push(`[sv1][ms]alphamerge[sv]`);
let last = "bg";
f.push(`[${last}][nv]overlay=${winNormal.x}:${winNormal.y}:enable='${enableFor("normal")}'[o1]`); last = "o1";
f.push(`[${last}][sv]overlay=${winSplitFinal.x}:${winSplitFinal.y}:enable='${enableFor("split")}'[o2]`); last = "o2";
if (hasPunch) {
  f.push(`[pv0]${kb(winNormal.w, winNormal.h, 1.34)}[pv1]`);
  f.push(`[pv1][mn2]alphamerge[pv]`);
  // tremblement court à l'entrée de chaque zoom "punch"
  const shake = merged.filter((s) => s.state === "punch")
    .map((s) => `between(t,${s.t0.toFixed(3)},${(s.t0 + 0.45).toFixed(3)})*8*sin(70*t)*(1-(t-${s.t0.toFixed(3)})/0.45)`).join("+") || "0";
  f.push(`[${last}][pv]overlay=x='${winNormal.x}+(${shake})':y='${winNormal.y}+(${shake})*0.6':enable='${enableFor("punch")}'[o3]`); last = "o3";
}
if (logoFile) {
  f.push(`[${iLogo}:v]scale=${L.logo.w}:${L.logo.h},format=yuva420p[lg0]`);
  f.push(`[${iML}:v]format=gray[ml]`);
  f.push(`[lg0][ml]alphamerge[lg]`);
  f.push(`[${last}][lg]overlay=${logoR.x}:${logoR.y}[o4]`); last = "o4";
}
f.push(`[${last}]ass=${CONTENT_DIR}/video.ass:fontsdir=fonts[oass]`); last = "oass";
usableEmoji.forEach((e, k) => {
  const ix = emojiIdx[k];
  const len = Math.max(0.2, e.t1 - e.t0);
  const fade = `fade=in:st=0:d=0.18:alpha=1,fade=out:st=${Math.max(0, len - 0.2).toFixed(3)}:d=0.2:alpha=1`;
  f.push(`[${ix}:v]scale=${e.size}:${e.size},format=rgba,${fade},setpts=PTS-STARTPTS+${e.t0.toFixed(3)}/TB[e${k}]`);
  const T0 = e.t0.toFixed(3);
  let ex = `${Math.round(e.x)}`, ey = `${Math.round(e.y)}`;
  if (e.kind === "sticker" || e.kind === "hook") ey = `${Math.round(e.y)}-14*abs(sin(5*(t-${T0})))`;
  if (e.kind === "float") { ey = `${Math.round(e.y)}-150*(t-${T0})`; ex = `${Math.round(e.x)}+22*sin(4*(t-${T0}))`; }
  f.push(`[${last}][e${k}]overlay=x='${ex}':y='${ey}':eof_action=pass:enable='between(t,${T0},${e.t1.toFixed(3)})'[oe${k}]`);
  last = `oe${k}`;
});
f.push(`[${last}]format=yuv420p[vout]`);

// audio : voix d'origine + effets sonores calés sur le montage
const byType = {};
sfxEvents.forEach((e, n) => { (byType[e.type] ||= []).push({ ...e, n }); });
const sfxLabels = [];
for (const [type, evs] of Object.entries(byType)) {
  const labels = evs.map((e) => `[x${e.n}]`);
  f.push(evs.length === 1 ? `[${sfxIdx[type]}:a]anull${labels[0]}` : `[${sfxIdx[type]}:a]asplit=${evs.length}${labels.join("")}`);
  evs.forEach((e) => {
    const ms = Math.max(0, Math.round(e.t * 1000));
    f.push(`[x${e.n}]adelay=${ms}|${ms},volume=${e.v}[y${e.n}]`);
    sfxLabels.push(`[y${e.n}]`);
  });
}
f.push(`${sfxLabels.join("")}amix=inputs=${sfxLabels.length}:normalize=0:duration=longest,aresample=48000,aformat=channel_layouts=stereo[sfx]`);
if (hasAudio) {
  f.push(`[${iSrc}:a]asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo[voice]`);
  f.push(`[voice][sfx]amix=inputs=2:normalize=0:duration=first,apad=whole_dur=${D.toFixed(3)},alimiter=limit=0.96[aout]`);
} else {
  f.push(`[sfx]apad,alimiter=limit=0.96[aout]`);
}

const scriptPath = `${CONTENT_DIR}/filter.txt`;
writeFileSync(scriptPath, f.join(";\n"));
const out = `${OUTPUT_DIR}/final.mp4`;
const args = [
  "-y", "-hide_banner", "-loglevel", "error", "-nostats",
  ...inputs,
  "-filter_complex_script", scriptPath,
  "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", process.env.X264_PRESET || "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
  "-t", D.toFixed(3), out,
];
function outDur(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", file]).toString());
  const get = (t) => Number(j.streams.find((x) => x.codec_type === t)?.duration) || 0;
  return { v: get("video"), a: get("audio") };
}
function runFfmpeg(srcFile) {
  const a = [...args];
  a[a.indexOf(videoPath)] = srcFile;
  execFileSync("ffmpeg", a, { stdio: "inherit" });
}
console.log("Rendu ffmpeg en cours...");
runFfmpeg(videoPath);
let od = outDur(out);
console.log(`Vérification : vidéo ${od.v.toFixed(1)} s / audio ${od.a.toFixed(1)} s (attendu ${D.toFixed(1)} s)`);
if (od.v < D - 1.0) {
  // le rendu est trop court : on normalise la source (image à cadence constante, timestamps réparés) et on recommence
  console.log("⚠ Vidéo trop courte : nouvelle tentative sur une copie normalisée de la source...");
  const norm = `${CONTENT_DIR}/source-cfr.mp4`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-err_detect", "ignore_err", "-i", videoPath, "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-af", "aresample=async=1:first_pts=0", "-c:a", "aac", "-b:a", "192k", norm], { stdio: "inherit" });
  runFfmpeg(norm);
  od = outDur(out);
  console.log(`Vérification (2e essai) : vidéo ${od.v.toFixed(1)} s / audio ${od.a.toFixed(1)} s`);
  if (od.v < D - 1.0) throw new Error(`Vidéo finale trop courte (${od.v.toFixed(1)} s au lieu de ${D.toFixed(1)} s). Voir les durées affichées plus haut.`);
}
console.log(`✔ ${out}`);
