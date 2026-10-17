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
import { Ass, PALETTE as P, c1, c3, c4, rrect, esc } from "./lib/ass.mjs";

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

// ---------- orientation : suit la vidéo (ou content/orientation.txt si présent) ----------
let vertical = info.height > info.width;
if (existsSync(`${CONTENT_DIR}/orientation.txt`)) {
  const f = readFileSync(`${CONTENT_DIR}/orientation.txt`, "utf8").trim().toLowerCase();
  if (f === "vertical") vertical = true;
  if (f === "horizontal") vertical = false;
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

// ---------- mesure réelle des glyphes (python + Pillow) ----------
// \fs d'ASS = hauteur de ligne complète, pas la taille du "M" : on mesure la police
// pour obtenir des tailles lisibles ET des retours à la ligne exacts.
function fontFile() {
  const local = rtl ? "Tajawal-ExtraBold.ttf" : "Poppins-ExtraBold.ttf";
  if (files.includes(local)) return `fonts/${local}`;
  const q = font.name.replace(" ExtraBold", "") + ":bold";
  const r = spawnSync("fc-match", ["-f", "%{file}", q]);
  return r.stdout?.toString().trim();
}
const allText = [
  plan.hook, ...plan.disclaimers, ...plan.beats.flatMap((b) => [b.headline, b.title, b.text, b.kicker]),
  ...tr.words.map((w) => w.w), "0123456789 ●.,;:!?'’\"«»()-–—%€$ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzéèêàçùôîïÉÀ",
].join(" ");
let M = { lf: 1.4, adv: {}, avg: 560 };
try {
  writeFileSync(`${CONTENT_DIR}/all-text.txt`, allText);
  const r = spawnSync("python3", ["scripts/font-metrics.py", fontFile(), `${CONTENT_DIR}/all-text.txt`], { maxBuffer: 1 << 26 });
  if (r.status === 0) {
    const j = JSON.parse(r.stdout.toString());
    const vals = Object.values(j.adv);
    M = { lf: j.lf, adv: j.adv, avg: vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length) };
  } else console.log("Mesure des polices indisponible (Pillow ?) — estimation approximative utilisée.");
} catch { console.log("Mesure des polices indisponible — estimation approximative utilisée."); }
const tw = (str, em) => ([...str].reduce((n, c) => n + (M.adv[c] ?? M.avg), 0) / 1000) * em;
const fs = (em) => Math.round(em * M.lf);
const nb = (t) => t.replace(/ +([?!:;»؟])/g, "\u00A0$1").replace(/(«) +/g, "$1\u00A0");
function wrapPx(text, maxPx, em, maxLines = 99) {
  const words = nb(esc(text)).split(/ +/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (tw(cur + " " + w, em) <= maxPx) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length > maxLines ? null : lines;
}
// coupe proprement (dernier mot entier) pour tenir dans maxLines
function wrapClamp(text, maxPx, em, maxLines) {
  let words = nb(esc(text)).split(/ +/);
  for (;;) {
    const l = wrapPx(words.join(" "), maxPx, em, maxLines);
    if (l) return l;
    words = words.slice(0, -1);
    if (words.length < 3) return [words.join(" ")];
  }
}
const lh = (em) => em * M.lf; // pas de ligne en px

// ---------- géométrie ----------
const even = (n) => Math.round(n / 2) * 2;
const mirror = (r) => (rtl ? { ...r, x: W - r.x - r.w } : r);
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
      ticker: { y: 1620, h: 54, size: 28 }, bannerMaxLines: 3, bannerSizes: [54, 48, 42, 36], titleSize: 44, bodySize: 31, hookSize: 80,
    }
  : {
      logo: { x: 44, y: 30, w: 120, h: 120 }, banner: { x: 190, y: 34, w: 1686, h: 128 },
      normalBox: { x: 320, y: 185, w: 1280, h: 720 }, splitBox: { x: 50, y: 185, w: 1130, h: 640 },
      panel: { x: 1210, y: 185, w: 660, h: 640 }, subsY: 1000, subsSize: 78, subsPx: 1560, subsWords: 5,
      ticker: { y: 1020, h: 54, size: 30 }, bannerMaxLines: 2, bannerSizes: [56, 50, 44, 38], titleSize: 50, bodySize: 33, hookSize: 88,
    };
const logoR = mirror(L.logo);
const bannerR = (() => {
  // la bannière occupe la place restante à côté du logo
  const b = L.banner;
  return rtl ? { ...b, x: W - b.x - b.w } : b;
})();
const winNormal = fit(mirror(L.normalBox), srcAspect);
const panelR = mirror(L.panel);
const winSplitFinal = fit(mirror(L.splitBox), srcAspect);

// ---------- timeline des états : normal / split / punch ----------
const beats = plan.beats.filter((b) => b.t0 < D).map((b) => ({ ...b, t1: Math.min(b.t1, D) }));
const segs = [];
beats.forEach((b, i) => {
  const len = b.t1 - b.t0;
  const canSplit = len >= 7 && b.text && b.text.length > 10;
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
const HOOK_END = Math.min(3.3, D * 0.4);
const FULL = `m 0 0 l ${W} 0 l ${W} ${H} l 0 ${H}`;

// 1) barre de progression
const pbY = H - 8;
ass.shape(2, 0, D, 0, pbY, `m 0 0 l ${W} 0 l ${W} 8 l 0 8`, c1(P.white, 0.3));
ass.shape(3, 0, D, rtl ? W : 0, pbY, `m 0 0 l ${W} 0 l ${W} 8 l 0 8`,
  `${c1(P.gold)}${rtl ? "\\an9" : ""}\\fscx1\\t(0,${Math.round(D * 1000)},\\fscx100)`);

// 2) fenêtre vidéo : halo + cadre fin, par segment
const winFor = (state) => (state === "split" ? winSplitFinal : winNormal);
for (const s of merged) {
  const w = winFor(s.state);
  const glow = s.state === "punch" ? P.gold : P.cyan;
  ass.shape(1, s.t0, s.t1, w.x, w.y, rrect(w.w, w.h, 26), `\\1a&HFF&${c3(glow, 0.55)}\\bord18\\blur14\\fad(120,0)`);
  ass.shape(4, s.t0, s.t1, w.x, w.y, rrect(w.w, w.h, 26), `\\1a&HFF&${c3(P.white, 0.95)}\\bord4\\blur0.6\\fad(120,0)`);
}

// 3) transitions flash à chaque changement d'état
merged.forEach((s, i) => {
  if (i === 0) return;
  ass.shape(9, s.t0, s.t0 + 0.28, 0, 0, FULL, `${c1(P.white, 0.45)}\\t(0,260,\\1a&HFF&)`);
});

// 4) logo (cadre accent)
ass.shape(5, 0, D, logoR.x, logoR.y, rrect(L.logo.w, L.logo.h, 26), `\\1a&HFF&${c3(P.accent)}\\bord6\\blur0.4`);

// 5) bandeau de headline
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
  const start = i === 0 ? HOOK_END - 0.2 : b.t0;
  const end = b.t1;
  if (end - start < 0.4) return;
  const { lines, em } = fitBanner(b.headline);
  const bx = bannerR.x, by = bannerR.y, bw = bannerR.w, bh = bannerR.h;
  const slide = rtl ? 70 : -70;
  ass.add(2, start, end, `{\\an7\\move(${bx + slide},${by},${bx},${by},0,260)\\bord0\\shad0${c1(P.dark, 0.93)}\\fad(220,140)\\p1}${rrect(bw, bh, 22)}{\\p0}`);
  const barX = rtl ? bx + bw - 14 : bx;
  ass.add(3, start, end, `{\\an7\\move(${barX + slide},${by},${barX},${by},0,260)\\bord0\\shad0${c1(P.accent)}\\fad(220,140)\\p1}${rrect(14, bh, 7)}{\\p0}`);
  const tx = rtl ? bx + bw - 40 : bx + 40;
  const ty = by + bh / 2;
  ass.add(6, start, end,
    `{\\an${rtl ? 6 : 4}\\move(${tx + slide},${ty},${tx},${ty},0,260)\\fs${fs(em)}\\bord0\\shad2${c4(P.black, 0.6)}${c1(P.white)}\\fad(220,140)}${lines.join("\\N")}`);
});

// 6) cartes d'analyse en split-screen
const emojiHex = (e) => [...(e || "")].map((c) => c.codePointAt(0).toString(16)).join("-");
const emojiFile = (e) => `assets/emoji/${emojiHex(e)}.png`;
const emojiOverlays = []; // {file, kind, t0, t1, x, y, size}
merged.filter((s) => s.state === "split").forEach((s) => {
  const b = beats[s.beat];
  const p = panelR;
  const t0 = s.t0 + 0.12, t1 = s.t1;
  const slide = rtl ? -90 : 90;
  const pad = 30;
  ass.add(1, t0, t1, `{\\an7\\move(${p.x + slide},${p.y},${p.x},${p.y},0,300)\\bord5${c3(P.cyan)}${c1(P.card, 0.94)}\\shad0\\fad(220,160)\\p1}${rrect(p.w, p.h, 28)}{\\p0}`);
  const innerW = p.w - pad * 2;
  const tx = rtl ? p.x + p.w - pad : p.x + pad;
  const an = rtl ? 9 : 7;
  let y = p.y + 26;
  // emoji icône (incrustation PNG) à côté du kicker
  const iconSize = 84;
  emojiOverlays.push({ file: emojiFile(b.emoji), kind: "card", t0, t1, x: rtl ? p.x + pad : p.x + p.w - pad - iconSize, y: p.y + 20, size: iconSize });
  // kicker (pastille)
  const kEm = vertical ? 28 : 30;
  const kicker = esc(b.kicker || "");
  const pillH = lh(kEm) * 0.72 + 16;
  const kW = Math.min(innerW - iconSize - 12, tw(kicker, kEm) + 44);
  const kx = rtl ? p.x + p.w - pad - kW : p.x + pad;
  ass.add(2, t0, t1, `{\\an7\\move(${kx + slide},${y},${kx},${y},0,300)\\bord0\\shad0${c1(P.accent)}\\fad(220,160)\\p1}${rrect(kW, pillH, pillH / 2)}{\\p0}`);
  ass.add(3, t0, t1, `{\\an5\\move(${kx + kW / 2 + slide},${y + pillH / 2},${kx + kW / 2},${y + pillH / 2},0,300)\\fs${fs(kEm)}\\bord0\\shad0${c1(P.white)}\\fad(220,160)}${kicker}`);
  y += pillH + 24;
  // titre (optionnel : absent quand il ne ferait que répéter la headline)
  const titleTxt = (b.title || "").trim();
  if (titleTxt && titleTxt !== (b.headline || "").trim()) {
    let tEm = L.titleSize;
    let tLines = wrapPx(titleTxt, innerW, tEm, 3);
    if (!tLines) { tEm = Math.round(tEm * 0.84); tLines = wrapClamp(titleTxt, innerW, tEm, 3); }
    ass.add(3, t0, t1, `{\\an${an}\\move(${tx + slide},${y},${tx},${y},0,300)\\fs${fs(tEm)}\\bord0\\shad2${c4(P.black, 0.6)}${c1(P.gold)}\\fad(260,160)}${tLines.join("\\N")}`);
    y += tLines.length * lh(tEm) + 12;
  }
  // ligne séparatrice
  ass.add(2, t0, t1, `{\\an7\\pos(${rtl ? tx - 90 : tx},${y})\\bord0\\shad0${c1(P.accent)}\\fad(300,160)\\p1}${rrect(90, 6, 3)}{\\p0}`);
  y += 22;
  // texte (valeur ajoutée) : on réduit la police puis on tronque proprement s'il déborde
  const room = p.y + p.h - 28 - y;
  let bEm = vertical ? 40 : 38;
  let bLines;
  for (;;) {
    bLines = wrapPx(b.text, innerW, bEm);
    if (bLines.length * lh(bEm) * 1.04 <= room || bEm <= 27) break;
    bEm -= 1;
  }
  const maxLinesBody = Math.max(2, Math.floor(room / (lh(bEm) * 1.04)));
  if (bLines.length > maxLinesBody) bLines = wrapClamp(b.text, innerW, bEm, maxLinesBody);
  ass.add(3, t0 + 0.15, t1, `{\\an${an}\\move(${tx + slide},${y},${tx},${y},0,340)\\fs${fs(bEm)}\\bord0\\shad1${c4(P.black, 0.5)}${c1(P.white)}\\fad(300,160)}${bLines.join("\\N")}`);

  // flèche pulsante qui relie la carte à la vidéo
  const w = winSplitFinal;
  const ax = rtl ? w.x - 4 : w.x + w.w + 4;
  const ay = w.y + w.h / 2;
  const dir = rtl ? 1 : -1; // pointe vers la vidéo
  const arrow = `m 0 0 l ${-dir * 24} ${-27} l ${-dir * 24} ${-11} l ${-dir * 40} ${-11} l ${-dir * 40} ${11} l ${-dir * 24} ${11} l ${-dir * 24} ${27}`;
  ass.add(8, t0 + 0.2, t1, `{\\an7\\pos(${ax},${ay})\\bord2${c3(P.dark)}\\shad0${c1(P.accent)}\\fad(200,150)\\t(0,500,\\fscx118\\fscy118)\\t(500,1000,\\fscx100\\fscy100)\\t(1000,1500,\\fscx118\\fscy118)\\t(1500,2000,\\fscx100\\fscy100)\\p1}${arrow}{\\p0}`);
});

// 7) hook d'ouverture
{
  const t0 = 0.15, t1 = HOOK_END;
  const box = winNormal;
  const hw = Math.min(box.w * 0.92, vertical ? 940 : 1200);
  let em = L.hookSize;
  let lines = wrapPx(plan.hook, hw - 90, em, 4);
  if (!lines) { em = Math.round(em * 0.8); lines = wrapClamp(plan.hook, hw - 90, em, 4); }
  const hh = lines.length * lh(em) + 64;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ass.add(7, t0, t1, `{\\an7\\pos(${cx - hw / 2},${cy - hh / 2})\\bord6${c3(P.gold)}${c1(P.dark, 0.92)}\\shad0\\fad(150,260)\\p1}${rrect(hw, hh, 34)}{\\p0}`);
  ass.add(8, t0, t1, `{\\an5\\pos(${cx},${cy})\\fs${fs(em)}\\fscx70\\fscy70\\t(0,220,\\fscx108\\fscy108)\\t(220,340,\\fscx100\\fscy100)\\bord0\\shad3${c4(P.black, 0.7)}${c1(P.white)}\\fad(150,260)}${lines.join("\\N")}`);
  emojiOverlays.push({ file: emojiFile(plan.hookEmoji), kind: "hook", t0, t1, x: cx - 80, y: cy - hh / 2 - 150, size: 160 });
}

// stickers emoji pendant les phases "normal" / "punch" (coin de la fenêtre)
merged.filter((s) => s.state !== "split").forEach((s) => {
  const b = beats[s.beat];
  if (s.t0 < HOOK_END) return;
  const w = winNormal;
  const size = vertical ? 130 : 140;
  emojiOverlays.push({
    file: emojiFile(b.emoji), kind: "sticker", t0: s.t0 + 0.2, t1: Math.min(s.t1, s.t0 + 3.6),
    x: rtl ? w.x - size * 0.35 : w.x + w.w - size * 0.65, y: w.y - size * 0.45, size,
  });
});

// 8) sous-titres dynamiques mot à mot (la phrase courante, le mot dit en jaune)
{
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
  phrases.forEach((ph, pi) => {
    const nextStart = pi < phrases.length - 1 ? phrases[pi + 1][0].t0 - 0.05 : Infinity;
    const prevEnd = pi > 0 ? phrases[pi - 1][phrases[pi - 1].length - 1].t1 + 0.02 : 0;
    ph.forEach((w, i) => {
      const t0 = i === 0 ? Math.max(prevEnd, w.t0 - 0.05) : w.t0;
      let t1 = i < ph.length - 1 ? ph[i + 1].t0 : Math.min(w.t1 + 0.18, nextStart);
      if (t1 - t0 < 0.12) t1 = t0 + 0.12;
      const line = ph.map((x, j) => {
        const wd = esc(x.w);
        return j === i ? `{${c1(P.gold)}\\fscx112\\fscy112}${wd}{${c1(P.white)}\\fscx100\\fscy100}` : wd;
      }).join(" ");
      const pop = i === 0 ? "\\fscx84\\fscy84\\t(0,110,\\fscx100\\fscy100)" : "";
      ass.add(10, t0, t1, `{\\an2\\pos(${cx},${L.subsY})\\fs${fs(L.subsSize)}${pop}\\bord${vertical ? 8 : 7}${c3(P.black)}\\shad3${c4(P.black, 0.6)}${c1(P.white)}}${line}`);
    });
  });
}

// 9) ticker de disclaimers permanent (protection : toujours visible)
{
  const tk = L.ticker;
  const mid = tk.y + tk.h / 2 + 1;
  ass.shape(11, 0, D, 0, tk.y, `m 0 0 l ${W} 0 l ${W} ${tk.h} l 0 ${tk.h}`, c1(P.dark, 0.9));
  ass.shape(11, 0, D, 0, tk.y, `m 0 0 l ${W} 0 l ${W} 3 l 0 3`, c1(P.accent));
  const sep = "      ●      ";
  const full = plan.disclaimers.map((t) => esc(lang === "ar" ? t : t.toUpperCase())).join(sep) + sep;
  const textW = tw(full, tk.size);
  const speed = 150;
  const cycle = textW / speed;
  const dur = (W + textW) / speed;
  for (let start = 0; start < D; start += cycle) {
    ass.add(12, start, Math.min(D, start + dur),
      `{\\an4\\move(${W},${mid},${-Math.round(textW)},${mid})\\clip(0,${tk.y},${W},${tk.y + tk.h})\\fs${fs(tk.size)}\\bord0\\shad0${c1(P.white)}}${full}`);
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
const SFX = {
  whoosh: synth("whoosh", "anoisesrc=d=0.55:c=pink:r=48000:a=0.9,highpass=f=500,lowpass=f=7000,afade=t=in:d=0.22,afade=t=out:st=0.2:d=0.35,tremolo=f=9:d=0.5"),
  pop: synth("pop", "sine=f=880:d=0.16:r=48000,afade=t=out:st=0.02:d=0.14,volume=1.2"),
  ding: synth("ding", "sine=f=1320:d=0.55:r=48000,aecho=0.7:0.6:60:0.4,afade=t=out:st=0.05:d=0.5"),
  impact: synth("impact", "sine=f=62:d=0.7:r=48000,afade=t=out:st=0.05:d=0.65,volume=2.2"),
};
const sfxEvents = [{ type: "impact", t: 0.1, v: 0.9 }];
beats.forEach((b, i) => { if (i > 0 || b.t0 + 0.2 >= HOOK_END) sfxEvents.push({ type: "ding", t: Math.max(b.t0, HOOK_END - 0.2), v: 0.35 }); });
merged.forEach((s, i) => { if (i > 0) sfxEvents.push({ type: "whoosh", t: s.t0, v: 0.55 }); });
emojiOverlays.filter((e) => e.kind === "sticker").forEach((e) => sfxEvents.push({ type: "pop", t: e.t0, v: 0.5 }));

// ---------- masques arrondis (une image fixe, générée par ffmpeg) ----------
function mask(name, w, h, r) {
  const out = `assets/mask-${name}-${w}x${h}.png`;
  if (existsSync(out)) return out;
  const ix = `max(max(${r}-X,X-(${w - 1}-${r})),0)`;
  const iy = `max(max(${r}-Y,Y-(${h - 1}-${r})),0)`;
  const expr = `clip(255*(${r}-sqrt(pow(${ix},2)+pow(${iy},2)))+128,0,255)`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=white:s=${w}x${h}:d=1,format=gray,geq=lum='${expr}'`, "-frames:v", "1", out]);
  return out;
}
const mNormal = mask("n", winNormal.w, winNormal.h, 26);
const mSplit = mask("s", winSplitFinal.w, winSplitFinal.h, 26);
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
const emojiIdx = usableEmoji.map((e) => addInput(["-loop", "1", "-framerate", String(FPS), "-i", e.file]));

const f = [];
const bw = even(W / 8), bh = even(H / 8);
const hasPunch = merged.some((s) => s.state === "punch");
f.push(`[${iSrc}:v]setpts=PTS-STARTPTS,fps=${FPS},setsar=1${padSec > 0.5 ? `,tpad=stop_mode=clone:stop_duration=${(padSec + 1).toFixed(2)}` : ""},split=${hasPunch ? 4 : 3}[bgs][nv0][sv0]${hasPunch ? "[pv0]" : ""}`);
f.push(`[bgs]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=5,eq=brightness=-0.2:saturation=1.6,hue=h='24*t':s=1.15,scale=${W}:${H}:flags=bicubic[bg]`);
f.push(`[${iMN}:v]format=gray,split=${hasPunch ? 2 : 1}${hasPunch ? "[mn1][mn2]" : "[mn1]"}`);
f.push(`[nv0]scale=${winNormal.w}:${winNormal.h},format=yuva420p[nv1]`);
f.push(`[nv1][mn1]alphamerge[nv]`);
f.push(`[sv0]scale=${winSplitFinal.w}:${winSplitFinal.h},format=yuva420p[sv1]`);
f.push(`[${iMS}:v]format=gray[ms]`);
f.push(`[sv1][ms]alphamerge[sv]`);
let last = "bg";
f.push(`[${last}][nv]overlay=${winNormal.x}:${winNormal.y}:enable='${enableFor("normal")}'[o1]`); last = "o1";
f.push(`[${last}][sv]overlay=${winSplitFinal.x}:${winSplitFinal.y}:enable='${enableFor("split")}'[o2]`); last = "o2";
if (hasPunch) {
  const Z = 1.32;
  f.push(`[pv0]scale=${even(winNormal.w * Z)}:${even(winNormal.h * Z)},crop=${winNormal.w}:${winNormal.h},format=yuva420p[pv1]`);
  f.push(`[pv1][mn2]alphamerge[pv]`);
  f.push(`[${last}][pv]overlay=${winNormal.x}:${winNormal.y}:enable='${enableFor("punch")}'[o3]`); last = "o3";
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
  const fade = `fade=in:st=${e.t0.toFixed(3)}:d=0.18:alpha=1,fade=out:st=${Math.max(e.t0, e.t1 - 0.2).toFixed(3)}:d=0.2:alpha=1`;
  f.push(`[${ix}:v]scale=${e.size}:${e.size},format=rgba,${fade}[e${k}]`);
  const bounce = e.kind === "card" ? `${Math.round(e.y)}` : `${Math.round(e.y)}-14*abs(sin(5*(t-${e.t0.toFixed(3)})))`;
  f.push(`[${last}][e${k}]overlay=${Math.round(e.x)}:'${bounce}':enable='between(t,${e.t0.toFixed(3)},${e.t1.toFixed(3)})'[oe${k}]`);
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
  f.push(`[voice][sfx]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.96[aout]`);
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
