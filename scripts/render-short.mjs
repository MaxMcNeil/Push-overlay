// scripts/render-short.mjs — rendu d'un SHORT (workflow « Video to Shorts »). Identité visuelle volontairement
// DIFFÉRENTE de Build Video (render-video.mjs) :
//   • vidéo PLEIN ÉCRAN (aucune fenêtre, aucun cadre néon, aucun fond flouté) avec "jump-zoom" à chaque idée et
//     lente poussée de caméra, micro-zooms sur les mots-clés ;
//   • transitions "glitch" (décalage RVB) ou "secousse" — jamais de flash ni de rideau ;
//   • sous-titres KARAOKÉ gros caractères condensés (Anton / Lalezar), mot actif sur boîte, en couleur ou souligné ;
//   • ÉTIQUETTE DE CHAPITRE inclinée façon tampon (au lieu du bandeau de headline) + emoji réaction ;
//   • PUCES (chips) qui s'empilent (au lieu des cartes split-screen) ;
//   • barre de progression SEGMENTÉE (une case par idée, façon stories) ;
//   • disclaimers en légende fixe qui alterne (au lieu du ticker défilant) — toujours visibles ;
//   • badge « extrait — vidéo complète en lien » puis carte de fin « VIDÉO COMPLÈTE ↓ lien juste en dessous » ;
//   • sons propres (swish, clics, boom, montée finale).
// Aucun texte sur le visage ni sur des sous-titres déjà incrustés (content/face.json, scripts/face-box.py), et rien
// dans les zones couvertes par l'interface YouTube Shorts / TikTok / Reels.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { CONTENT_DIR, OUTPUT_DIR, findVideo, probeVideo, listFontFiles } from "./lib/util.mjs";
import { Ass, c1, c3, c4, rrect, esc } from "./lib/ass.mjs";
import { measureTokens } from "./lib/measure.mjs";
import { shortStyle } from "./lib/short-styles.mjs";

const plan = JSON.parse(readFileSync(`${CONTENT_DIR}/plan.json`, "utf8"));
const tr = JSON.parse(readFileSync(`${CONTENT_DIR}/transcript.json`, "utf8"));
const videoPath = findVideo();
if (!videoPath) throw new Error("Aucune vidéo dans input/.");
const info = probeVideo(videoPath);
function measureDecoded(file, kind) {
  const map = kind === "v" ? ["-map", "0:v:0", "-an"] : ["-map", "0:a:0", "-vn"];
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostats", "-progress", "pipe:1", "-i", file, ...map, "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const m = [...(r.stdout?.toString() || "").matchAll(/out_time_us=(\d+)/g)].pop();
  return m ? Number(m[1]) / 1e6 : 0;
}
const decV = measureDecoded(videoPath, "v");
const decA = info.hasAudio ? measureDecoded(videoPath, "a") : 0;
const D = Math.min(Math.max(decV, decA, 1), info.duration || 1e9, (plan.duration || 1e9) + 1);
const padSec = Math.max(0, D - decV);
const lang = plan.lang || "fr";
const rtl = lang === "ar";
const SAFE = !!process.env.SAFE_MODE;
const ST = shortStyle(process.env.SHORT_STYLE);
const P = ST.pal;
const W = 1080, H = 1920, FPS = info.fps;
console.log(`Short ${D.toFixed(1)} s, ${info.width}x${info.height} → ${W}x${H} plein écran, style « ${ST.id} », langue ${lang}${SAFE ? " (mode sûr)" : ""}`);

const TXT = {
  fr: { badge: "EXTRAIT · VIDÉO COMPLÈTE EN LIEN", cta1: "VIDÉO COMPLÈTE", cta2: "Lien juste en dessous" },
  en: { badge: "CLIP · FULL VIDEO LINKED BELOW", cta1: "FULL VIDEO", cta2: "Link right below" },
  it: { badge: "ESTRATTO · VIDEO COMPLETO NEL LINK", cta1: "VIDEO COMPLETO", cta2: "Link qui sotto" },
  ar: { badge: "مقتطف · الفيديو الكامل في الرابط", cta1: "الفيديو الكامل", cta2: "الرابط في الأسفل" },
}[lang] || null;
const T_ = TXT || { badge: "EXTRAIT · VIDÉO COMPLÈTE EN LIEN", cta1: "VIDÉO COMPLÈTE", cta2: "Lien juste en dessous" };

// ---------- police (condensée, très différente de Build Video) ----------
const files = listFontFiles();
function familyOf(file) {
  const r = spawnSync("fc-scan", ["--format", "%{family}\\n", file]);
  return (r.stdout?.toString() || "").trim().split(/[,\n]/).map((x) => x.trim()).filter(Boolean)[0] || null;
}
const fontChoice = (() => {
  const wants = rtl ? ["Lalezar-Regular.ttf", "Tajawal-ExtraBold.ttf"] : ["Anton-Regular.ttf", "Poppins-ExtraBold.ttf"];
  for (const f of wants) if (files.includes(f)) { const fam = familyOf(`fonts/${f}`); if (fam) return { name: fam, bold: false, file: `fonts/${f}` }; }
  return { name: "DejaVu Sans", bold: true, file: spawnSync("fc-match", ["-f", "%{file}", "DejaVu Sans:bold"]).stdout?.toString().trim() };
})();
const font = { name: fontChoice.name, bold: fontChoice.bold };
let LF = 1.4;
try {
  writeFileSync(`${CONTENT_DIR}/lf.txt`, "Mg");
  const r = spawnSync("python3", ["scripts/font-metrics.py", fontChoice.file, `${CONTENT_DIR}/lf.txt`], { maxBuffer: 1 << 24 });
  if (r.status === 0) LF = JSON.parse(r.stdout.toString()).lf || 1.4;
} catch {}
console.log(`Police : ${font.name}`);

// ---------- texte : mesure exacte ----------
const up = (t) => (ST.upper && !rtl ? String(t).toLocaleUpperCase(lang) : String(t));
const nb = (t) => t.replace(/ +([?!:;»؟])/g, " $1").replace(/(«) +/g, "$1 ");
const tokensOf = (text) => nb(esc(text)).split(/ +/).filter(Boolean);
const disclaimers = plan.disclaimers || [];
const allTok = new Set(["●", "|"]);
[plan.hook && up(plan.hook), T_.badge, up(T_.cta1), T_.cta2, ...disclaimers,
  ...plan.beats.flatMap((b) => [b.headline && up(b.headline), ...(b.points || [])]), ...tr.words.map((w) => up(w.w))]
  .filter(Boolean).forEach((t) => tokensOf(t).forEach((k) => allTok.add(k)));
const TM = measureTokens({ tokens: [...allTok], font, dir: CONTENT_DIR });
const fsz = (em) => Math.round(em * LF);
const lh = (em) => em * LF;
const wordPx = (t, em) => ((TM.w.get(t) ?? t.length * TM.avg) * fsz(em)) / 100;
const gapPx = (em) => (TM.space * 1.25 * fsz(em)) / 100; // police condensée : espaces un peu plus larges
const lineW = (line, em) => { const k = line.split(" ").filter(Boolean); return k.reduce((n, t) => n + wordPx(t, em), 0) + Math.max(0, k.length - 1) * gapPx(em); };
function wrapPx(text, maxPx, em, maxLines = 99) {
  const lines = []; let cur = "";
  for (const w of tokensOf(text)) { if (!cur) cur = w; else if (lineW(cur + " " + w, em) <= maxPx) cur += " " + w; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  return lines.length > maxLines ? null : lines;
}
function wrapFit(text, maxPx, em, maxLines, minEm) {
  for (let e = em; e >= minEm; e -= 2) { const l = wrapPx(text, maxPx, e, maxLines); if (l) return { lines: l, em: e }; }
  let words = tokensOf(text);
  while (words.length > 2) { words = words.slice(0, -1); const l = wrapPx(words.join(" "), maxPx, minEm, maxLines); if (l) return { lines: l, em: minEm }; }
  return { lines: [words.join(" ")], em: minEm };
}
const strip = (t) => t.replace(/[\p{P}\p{S} ]/gu, "");
const keyWord = (text) => tokensOf(text).map(strip).filter((t) => t.length >= 4).sort((a, b) => b.length - a.length)[0] || "";

const ass = new Ass(W, H, font.name, font.bold);
// place une ligne centrée en cx, un événement par mot (ordre de lecture exact, aussi en arabe) ; renvoie la géométrie
function lineGeom(line, em, cx) {
  const toks = line.split(" ").filter(Boolean);
  const total = lineW(line, em);
  let x = rtl ? cx + total / 2 : cx - total / 2;
  return toks.map((t) => { const w = wordPx(t, em); const xc = rtl ? x - w / 2 : x + w / 2; x += (rtl ? -1 : 1) * (w + gapPx(em)); return { t, w, xc }; });
}

// ---------- zones libres (visage + sous-titres incrustés protégés, interface des applis évitée) ----------
const SAFE_TOP = 150, SAFE_BOT = 1500;
const srcH = Math.max(H, (W * info.height) / info.width); // hauteur de la vidéo une fois "cover" plein écran
const Zmax = 1 + ST.jump + ST.push + 0.03;
const fy = (v, z) => H / 2 + (v - 0.5) * srcH * z;
let face = { found: false, y0: 0.08, y1: 0.56 }, caps = null;
try { const f = JSON.parse(readFileSync(`${CONTENT_DIR}/face.json`, "utf8")); if (f.found) face = f; caps = f.captions || null; } catch {}
const bandOf = (b) => ({ y0: Math.min(fy(b.y0, Zmax), fy(b.y0, 1)) - 16, y1: Math.max(fy(b.y1, Zmax), fy(b.y1, 1)) + 16 });
const prot = [{ what: "visage", ...bandOf(face) }];
if (caps) prot.push({ what: "sous-titres incrustés", ...bandOf(caps) });
prot.forEach((p) => console.log(`Zone protégée (${p.what}${p.what === "visage" && !face.found ? ", position par défaut" : ""}) : y ${Math.round(p.y0)}→${Math.round(p.y1)}`));
let gaps = [{ y0: SAFE_TOP, y1: SAFE_BOT }];
for (const p of prot) gaps = gaps.flatMap((g) => [{ y0: g.y0, y1: Math.min(g.y1, p.y0) }, { y0: Math.max(g.y0, p.y1), y1: g.y1 }]).filter((g) => g.y1 - g.y0 > 40);
const room = (g) => g.y1 - g.y0;
const take = (g, h, fromBottom) => { const y = fromBottom ? g.y1 - h : g.y0; if (fromBottom) g.y1 -= h + 10; else g.y0 += h + 10; return y; };
const lowest = (min) => gaps.filter((g) => room(g) >= min).sort((a, b) => b.y1 - a.y1)[0];
const faceMid = (prot[0].y0 + prot[0].y1) / 2;
// 1) disclaimers (toujours visibles)
const gD = lowest(84);
const DISC = { y: gD ? take(gD, 76, true) : SAFE_BOT - 76, h: 76 };
// 2) sous-titres
const autoSubsOff = !!caps && !process.env.SUBTITLES;
const subsOn = !autoSubsOff && String(process.env.SUBTITLES || "full") !== "off";
const CAP_H = 150;
let CAP_Y = DISC.y - CAP_H / 2 - 10;
if (subsOn) { const g = lowest(CAP_H); if (g) CAP_Y = take(g, CAP_H, true) + CAP_H / 2; }
if (autoSubsOff) console.log("Sous-titres déjà incrustés dans la vidéo : nos sous-titres sont désactivés.");
// 3) étiquette de chapitre
const above = gaps.filter((g) => g.y1 <= faceMid && room(g) >= 110).sort((a, b) => room(b) - room(a))[0];
const gT = above || gaps.filter((g) => room(g) >= 100).sort((a, b) => room(b) - room(a))[0];
const TAG = (() => { if (!gT) return { y: SAFE_TOP, h: 100 }; const h = Math.min(130, room(gT)); return { y: take(gT, h, gT !== above), h }; })();
// 4) puces
const gC = gaps.filter((g) => room(g) >= 190).sort((a, b) => room(b) - room(a))[0];
const CHIPS = gC ? { y0: gC.y0, y1: gC.y1 } : null;
// 5) hook / badge / carte de fin : la plus grande zone disponible autour de l'étiquette
const near = CHIPS && Math.abs(CHIPS.y0 - (TAG.y + TAG.h)) < 30;
const BIG = near ? { y0: TAG.y, y1: CHIPS.y1 } : CHIPS && CHIPS.y1 - CHIPS.y0 > TAG.h ? CHIPS : { y0: TAG.y, y1: TAG.y + TAG.h };
console.log(`Zones : étiquette y=${Math.round(TAG.y)} h=${Math.round(TAG.h)}, ${CHIPS ? `puces y=${Math.round(CHIPS.y0)}→${Math.round(CHIPS.y1)}` : "pas de puces (pas de place hors visage)"}, ${subsOn ? `sous-titres y≈${Math.round(CAP_Y)}` : "sans sous-titres"}, disclaimers y=${Math.round(DISC.y)}`);

// ---------- timeline ----------
const beats = plan.beats.filter((b) => b.t0 < D - 0.3).map((b) => ({ ...b, t1: Math.min(b.t1, D) }));
const HOOK_END = plan.hook ? Math.min(3.0, D * 0.3) : 0.2;
const CTA_LEN = Math.min(3.6, Math.max(2.2, D * 0.12));
const CTA_START = Math.max(HOOK_END + 2, D - CTA_LEN);
// badge « extrait » : dans la zone des puces s'il y en a une, sinon à la place de la 1re étiquette (qui attend)
const BADGE = { t0: HOOK_END + 0.1, t1: Math.min(HOOK_END + 3.2, CTA_START - 0.3) };
const BADGE_IN_TAG = !CHIPS;
const TAG_FROM = BADGE_IN_TAG && BADGE.t1 - BADGE.t0 > 1 ? BADGE.t1 + 0.05 : HOOK_END;
const emojiHex = (e) => [...(e || "")].map((c) => c.codePointAt(0).toString(16)).join("-");
const emojiOverlays = [];

// 1) barre de progression segmentée (une case par idée)
{
  const n = Math.max(1, beats.length), x0 = 34, x1 = W - 34, gap = 10, y = 28, h = 8;
  const segW = (x1 - x0 - gap * (n - 1)) / n;
  beats.forEach((b, i) => {
    const x = x0 + i * (segW + gap);
    const xx = rtl ? W - x - segW : x;
    ass.shape(20, 0, D, xx, y, rrect(segW, h, 4), c1("#FFFFFF", 0.32));
    const dur = Math.max(0.1, b.t1 - b.t0);
    ass.add(21, b.t0, b.t1, `{\\an${rtl ? 9 : 7}\\pos(${Math.round(rtl ? xx + segW : xx)},${y})\\bord0\\shad0${c1(P.accent)}\\fscx0\\t(0,${Math.round(dur * 1000)},\\fscx100)\\p1}${rrect(segW, h, 4)}{\\p0}`);
    if (b.t1 < D - 0.05) ass.shape(21, b.t1, D, xx, y, rrect(segW, h, 4), c1(P.accent));
  });
}

// 2) étiquette de chapitre (une par idée) + emoji réaction ; logo à côté
const logoFile = [`input/logo-${rtl ? "ar" : "fr"}.png`, "input/logo.png", "input/logo-fr.png"].find((f) => existsSync(f));
const LOGO = Math.round(Math.min(96, TAG.h - 12));
const tagX0 = logoFile ? 40 + LOGO + 16 : 50;
const tagMaxW = W - tagX0 - 50;
function tagShape(w, h) {
  if (ST.tagShape === "pill") return rrect(w, h, h / 2);
  if (ST.tagShape === "slant") return `m 22 0 l ${w} 0 l ${w - 22} ${h} l 0 ${h}`;
  return rrect(w, h, 8);
}
beats.forEach((b, i) => {
  if (!b.headline) return;
  const t0 = Math.max(b.t0, TAG_FROM), t1 = Math.min(b.t1, CTA_START);
  if (t1 - t0 < 0.8) return;
  const { lines, em } = wrapFit(up(b.headline), tagMaxW - 56, 46, TAG.h >= 120 ? 2 : 1, 28);
  const bw = Math.min(tagMaxW, Math.max(...lines.map((l) => lineW(l, em))) + 56);
  const bh = Math.min(TAG.h, lines.length * lh(em) * 0.92 + 26);
  const bx = rtl ? W - tagX0 - bw : tagX0, by = TAG.y + (TAG.h - bh) / 2;
  const cx = bx + bw / 2, cy = by + bh / 2;
  const tilt = (i % 2 ? -1 : 1) * ST.tagTilt;
  const stamp = `\\org(${Math.round(cx)},${Math.round(cy)})\\frz${tilt}\\fscx0\\fscy0\\t(0,160,\\fscx112\\fscy112)\\t(160,260,\\fscx100\\fscy100)\\fad(0,140)`;
  ass.add(22, t0, t1, `{\\an7\\pos(${Math.round(bx)},${Math.round(by)})\\bord0\\shad6${c4("#000000", 0.45)}${c1(P.accent)}${stamp}\\p1}${tagShape(bw, bh)}{\\p0}`);
  lines.forEach((ln, k) => {
    const yc = cy + (k - (lines.length - 1) / 2) * lh(em) * 0.92;
    for (const g of lineGeom(ln, em, cx)) {
      ass.add(23, t0 + 0.06, t1, `{\\an5\\pos(${Math.round(g.xc)},${Math.round(yc)})\\fs${fsz(em)}\\bord0\\shad0${c1(P.accentText)}${stamp}}${g.t}`);
    }
  });
  if (b.emoji) emojiOverlays.push({ file: `assets/emoji/${emojiHex(b.emoji)}.png`, kind: "react", t0: t0 + 0.25, t1: Math.min(t1, t0 + 1.9), x: rtl ? bx - 70 : bx + bw - 40, y: by - 52, size: 104 });
});

// 3) puces qui s'empilent (valeur ajoutée), seulement s'il y a une zone libre hors visage
if (CHIPS && !SAFE) beats.forEach((b) => {
  const pts = (b.points || []).filter(Boolean).slice(0, 3);
  const t1 = Math.min(b.t1, CTA_START) - 0.05;
  if (!pts.length || t1 - b.t0 < 5) return;
  let y = CHIPS.y0;
  pts.forEach((pt, k) => {
    const t0 = Math.max(HOOK_END, b.t0) + Math.max(1.2, (t1 - b.t0) * 0.28) + k * 0.5;
    if (t0 > t1 - 1) return;
    const { lines, em } = wrapFit(pt, 860, 36, 2, 28);
    const w = Math.max(...lines.map((l) => lineW(l, em))) + 86, h = lines.length * lh(em) * 0.95 + 24;
    if (y + h > CHIPS.y1) return;
    const x = rtl ? W - 60 - w : 60;
    const slide = rtl ? 70 : -70;
    ass.add(24, t0, t1, `{\\an7\\move(${x + slide},${Math.round(y)},${x},${Math.round(y)},0,180)\\bord0\\shad4${c4("#000000", 0.35)}${c1(P.chipBg, 0.94)}\\fad(150,150)\\p1}${rrect(w, h, 18)}{\\p0}`);
    const dx = rtl ? x + w - 36 : x + 24;
    ass.add(25, t0 + 0.05, t1, `{\\an7\\move(${dx + slide},${Math.round(y + h / 2 - 7)},${dx},${Math.round(y + h / 2 - 7)},0,180)\\bord0\\shad0${c1(P.dot)}\\fad(150,150)\\p1}m 7 0 b 11 0 14 3 14 7 b 14 11 11 14 7 14 b 3 14 0 11 0 7 b 0 3 3 0 7 0{\\p0}`);
    lines.forEach((ln, j) => {
      const yc = y + 12 + (j + 0.5) * lh(em) * 0.95;
      const tx = rtl ? x + w - 52 : x + 52;
      ass.add(25, t0 + 0.08, t1, `{\\an${rtl ? 6 : 4}\\move(${tx + slide},${Math.round(yc)},${tx},${Math.round(yc)},0,180)\\fs${fsz(em)}\\bord0\\shad0${c1(P.chipText)}\\fad(150,150)}${ln}`);
    });
    y += h + 14;
  });
});

// 4) hook d'ouverture : gros texte, mot-clé surligné au marqueur
if (plan.hook) {
  const zoneH = BIG.y1 - BIG.y0;
  const { lines, em } = wrapFit(up(plan.hook), 960, 96, 3, 44);
  let e = em, ls = lines;
  while (ls.length * lh(e) > zoneH && e > 40) { e -= 4; ls = wrapFit(up(plan.hook), 960, e, 3, 40).lines; }
  const key = keyWord(up(plan.hook));
  const cy0 = (BIG.y0 + BIG.y1) / 2;
  ls.forEach((ln, k) => {
    const yc = cy0 + (k - (ls.length - 1) / 2) * lh(e);
    for (const g of lineGeom(ln, e, W / 2)) {
      const isKey = key && strip(g.t) === key;
      if (isKey) { const bw = g.w + 26, bh = lh(e) * 0.82; ass.add(26, 0.25, HOOK_END, `{\\an${rtl ? 9 : 7}\\pos(${Math.round(rtl ? g.xc + bw / 2 : g.xc - bw / 2)},${Math.round(yc - bh / 2 + lh(e) * 0.04)})\\bord0\\shad0${c1(P.accent)}\\fscx0\\t(150,330,\\fscx100)\\fad(0,180)\\p1}${rrect(bw, bh, 10)}{\\p0}`); }
      ass.add(27, 0.12, HOOK_END, `{\\an5\\pos(${Math.round(g.xc)},${Math.round(yc)})\\fs${fsz(e)}\\bord${isKey ? 0 : 6}${c3("#000000")}\\shad0${c1(isKey ? P.accentText : "#FFFFFF")}\\fscx135\\fscy135\\t(0,140,\\fscx100\\fscy100)\\fad(60,180)}${g.t}`);
    }
  });
}
// 5) badge « extrait — vidéo complète en lien » juste après le hook
{
  const { t0, t1 } = BADGE;
  if (t1 - t0 > 1) {
    const em = 30, w = lineW(T_.badge, em) + 70, h = lh(em) + 18;
    const x = (W - w) / 2, y = BADGE_IN_TAG ? TAG.y + (TAG.h - h) / 2 : CHIPS.y0;
    ass.add(28, t0, t1, `{\\an7\\pos(${Math.round(x)},${Math.round(y)})\\bord0\\shad0${c1("#000000", 0.72)}\\fad(180,220)\\p1}${rrect(w, h, h / 2)}{\\p0}`);
    ass.add(29, t0, t1, `{\\an7\\pos(${Math.round(rtl ? x + w - 34 : x + 22)},${Math.round(y + h / 2 - 7)})\\bord0\\shad0${c1(P.accent)}\\fad(180,220)\\t(0,500,\\1a&H80&)\\t(500,1000,\\1a&H00&)\\t(1000,1500,\\1a&H80&)\\t(1500,2000,\\1a&H00&)\\p1}m 7 0 b 11 0 14 3 14 7 b 14 11 11 14 7 14 b 3 14 0 11 0 7 b 0 3 3 0 7 0{\\p0}`);
    ass.add(29, t0, t1, `{\\an5\\pos(${Math.round(W / 2 + (rtl ? -12 : 12))},${Math.round(y + h / 2)})\\fs${fsz(em)}\\bord0\\shad0${c1("#FFFFFF")}\\fad(180,220)}${T_.badge}`);
  }
}

// 6) carte de fin : VIDÉO COMPLÈTE + « lien juste en dessous » + flèches qui rebondissent vers le bas
{
  const t0 = CTA_START, t1 = D;
  const zone = BIG, cy = (zone.y0 + zone.y1) / 2;
  // taille calculée pour que le bloc (titre + ligne + flèches) remplisse la zone libre
  const e1 = Math.round(Math.min(96, Math.max(34, ((zone.y1 - zone.y0) - 34) / (LF * 1.42)))), e2 = Math.round(e1 * 0.5);
  const l1 = up(T_.cta1), w1 = lineW(l1, e1) + 70, h1 = lh(e1) * 0.9 + 20;
  const y1 = cy - (h1 + lh(e2) * 0.95) / 2;
  ass.add(30, t0, t1, `{\\an7\\pos(${Math.round((W - w1) / 2)},${Math.round(y1)})\\bord0\\shad8${c4("#000000", 0.5)}${c1(P.accent)}\\org(${W / 2},${Math.round(y1 + h1 / 2)})\\frz${ST.tagTilt}\\fscx0\\fscy0\\t(0,180,\\fscx110\\fscy110)\\t(180,300,\\fscx100\\fscy100)\\p1}${tagShape(w1, h1)}{\\p0}`);
  for (const g of lineGeom(l1, e1, W / 2)) ass.add(31, t0 + 0.05, t1, `{\\an5\\pos(${Math.round(g.xc)},${Math.round(y1 + h1 / 2)})\\fs${fsz(e1)}\\bord0\\shad0${c1(P.accentText)}\\org(${W / 2},${Math.round(y1 + h1 / 2)})\\frz${ST.tagTilt}\\fscx0\\fscy0\\t(0,180,\\fscx110\\fscy110)\\t(180,300,\\fscx100\\fscy100)}${g.t}`);
  const y2 = y1 + h1 + lh(e2) * 0.5;
  const w2 = lineW(T_.cta2, e2);
  ass.add(31, t0 + 0.25, t1, `{\\an5\\pos(${Math.round(W / 2 - 34)},${Math.round(y2)})\\fs${fsz(e2)}\\bord5${c3("#000000")}\\shad0${c1("#FFFFFF")}\\fad(200,0)}${T_.cta2}`);
  const chev = (s) => `m 0 0 l ${s} ${s * 0.75} l ${s * 2} 0 l ${s * 2} ${s * 0.4} l ${s} ${s * 1.15} l 0 ${s * 0.4}`;
  // flèches qui rebondissent vers le bas, à droite de la ligne (prennent peu de hauteur)
  const ax = Math.round(W / 2 - 34 + w2 / 2 + 22), cs = Math.max(12, Math.round(e2 * 0.42));
  [0, 1].forEach((k) => {
    const yy = Math.round(y2 - cs * 0.9 + k * cs * 0.85);
    const bounce = [0, 1, 2, 3, 4, 5].map((j) => `\\t(${j * 300},${j * 300 + 150},\\fry0\\1a&H${k ? "60" : "00"}&)\\t(${j * 300 + 150},${j * 300 + 300},\\1a&H${k ? "C0" : "90"}&)`).join("");
    ass.add(31, t0 + 0.4 + k * 0.12, t1, `{\\an7\\move(${ax},${yy},${ax},${yy + Math.round(cs * 0.5)},0,600)\\bord3${c3("#000000")}\\shad0${c1(P.accent)}${bounce}\\p1}${chev(cs)}{\\p0}`);
  });
}

// 7) sous-titres karaoké
if (subsOn) {
  const em = rtl ? 74 : 84;
  const words = tr.words.filter((w) => w.t0 < D);
  const phrases = []; let cur = [];
  for (const w of words) {
    const gap = cur.length ? w.t0 - cur[cur.length - 1].t1 : 0;
    const wide = lineW([...cur, w].map((x) => up(esc(x.w))).join(" "), em);
    if (cur.length && (cur.length >= 3 || wide > 940 || gap > 0.45)) { phrases.push(cur); cur = []; }
    cur.push(w);
    if (/[.!?؟…]$/.test(w.w) && cur.length >= 1) { phrases.push(cur); cur = []; }
  }
  if (cur.length) phrases.push(cur);
  const evs = [];
  phrases.forEach((ph, pi) => {
    const next = phrases[pi + 1]?.[0]?.t0 ?? Infinity;
    const prevEnd = pi ? phrases[pi - 1].at(-1).t1 + 0.02 : 0;
    const line = ph.map((x) => up(esc(x.w))).join(" ");
    const geo = lineGeom(line, em, W / 2);
    ph.forEach((w, i) => {
      const t0 = i === 0 ? Math.max(prevEnd, w.t0 - 0.04) : w.t0;
      let t1 = i < ph.length - 1 ? ph[i + 1].t0 : Math.min(w.t1 + 0.2, next - 0.03);
      if (t1 - t0 < 0.1) t1 = t0 + 0.1;
      const ins = i === 0 ? `\\move(%X,${Math.round(CAP_Y + 26)},%X,${Math.round(CAP_Y)},0,110)\\fad(70,0)` : `\\pos(%X,${Math.round(CAP_Y)})`;
      const texts = [];
      geo.forEach((g, j) => {
        const act = j === i;
        if (act && ST.caption === "box") texts.push({ layer: 32, text: `{\\an7\\pos(${Math.round(g.xc - g.w / 2 - 14)},${Math.round(CAP_Y - lh(em) * 0.45)})\\bord0\\shad0${c1(P.accent)}\\fscx92\\fscy92\\t(0,70,\\fscx100\\fscy100)\\p1}${rrect(g.w + 28, lh(em) * 0.86, 14)}{\\p0}` });
        if (act && ST.caption === "underline") texts.push({ layer: 32, text: `{\\an7\\pos(${Math.round(g.xc - g.w / 2)},${Math.round(CAP_Y + lh(em) * 0.36)})\\bord0\\shad0${c1(P.accent)}\\fscx0\\t(0,90,\\fscx100)\\p1}${rrect(g.w, 12, 6)}{\\p0}` });
        const col = act ? (ST.caption === "box" ? P.accentText : ST.caption === "color" ? P.accent : "#FFFFFF") : "#FFFFFF";
        const bord = act && ST.caption === "box" ? 0 : 6;
        const sc = act && ST.caption === "color" ? "\\fscy116" : ""; // grandit en hauteur seulement : ne touche jamais le mot voisin
        texts.push({ layer: 33, text: `{\\an5${ins.replace(/%X/g, Math.round(g.xc))}\\fs${fsz(em)}\\bord${bord}${c3("#000000")}\\shad3${c4("#000000", 0.55)}${c1(col)}${sc}}${g.t}` });
      });
      evs.push({ t0, t1, texts });
    });
  });
  for (let k = 1; k < evs.length; k++) { const a = evs[k - 1], b = evs[k]; if (b.t0 < a.t1) { a.t1 = Math.max(a.t0 + 0.05, b.t0); } }
  evs.forEach((e) => e.texts.forEach((x) => ass.add(x.layer, e.t0, e.t1, x.text)));
}

// 8) disclaimers : légende fixe qui alterne (toujours un disclaimer à l'écran)
if (disclaimers.length) {
  const per = 7;
  let k = 0;
  for (let t = 0; t < D; t += per, k++) {
    const txt = disclaimers[k % disclaimers.length];
    const { lines, em } = wrapFit(txt, 1000, 21, 3, 15);
    const h = lines.length * lh(em) + 12;
    const y = DISC.y + DISC.h - h;
    const t1 = Math.min(D, t + per);
    ass.add(34, t, t1, `{\\an7\\pos(0,${Math.round(y)})\\bord0\\shad0${c1("#000000", 0.55)}\\p1}m 0 0 l ${W} 0 l ${W} ${Math.round(h)} l 0 ${Math.round(h)}{\\p0}`);
    ass.add(35, t, t1, `{\\an8\\pos(${W / 2},${Math.round(y + 6)})\\fs${fsz(em)}\\bord0\\shad0${c1("#FFFFFF", 0.92)}\\fad(${t ? 250 : 0},250)}${lines.join("\\N")}`);
  }
}

// ---------- sons propres aux shorts ----------
mkdirSync("assets/sfx", { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });
function synth(name, src) {
  const out = `assets/sfx/short-${name}.wav`;
  if (!existsSync(out)) execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", src, "-ar", "48000", "-ac", "2", out]);
  return out;
}
const V = { a: { sw: 2600, ck: 2200, bm: 46, rs: 220 }, b: { sw: 1800, ck: 1600, bm: 38, rs: 160 }, c: { sw: 3400, ck: 2800, bm: 55, rs: 280 } }[ST.sfx] || { sw: 2600, ck: 2200, bm: 46, rs: 220 };
const SFX = {
  swish: synth(`swish-${ST.sfx}`, `anoisesrc=d=0.32:c=white:r=48000:a=0.5,bandpass=f=${V.sw}:width_type=h:w=${V.sw * 0.7},afade=t=in:d=0.1,afade=t=out:st=0.1:d=0.22`),
  click: synth(`click-${ST.sfx}`, `sine=f=${V.ck}:d=0.045:r=48000,afade=t=out:st=0.004:d=0.04,volume=0.9`),
  boom: synth(`boom-${ST.sfx}`, `sine=f=${V.bm}:d=0.9:r=48000,afade=t=out:st=0.02:d=0.85,volume=2.4`),
  riser: synth(`riser-${ST.sfx}`, `aevalsrc='0.35*sin(2*PI*(${V.rs}+${V.rs * 2}*t)*t)':d=1.1:s=48000,afade=t=in:d=0.6,afade=t=out:st=0.95:d=0.15`),
};
const sfxEvents = [{ type: "boom", t: 0.05, v: 0.8 }];
beats.forEach((b, i) => { if (i > 0 && b.t0 < CTA_START) sfxEvents.push({ type: "swish", t: b.t0 - 0.05, v: 0.5 }); if (b.headline && b.t0 < CTA_START) sfxEvents.push({ type: "click", t: Math.max(b.t0, HOOK_END), v: 0.45 }); });
if (CTA_START > 1.2) sfxEvents.push({ type: "riser", t: CTA_START - 1.05, v: 0.5 }, { type: "click", t: CTA_START, v: 0.6 });

// ---------- caméra : plein écran, jump-zoom par idée, poussée lente, micro-zooms sur les mots-clés ----------
const Tz = `(on/${FPS})`;
const beatTerm = beats.map((b, i) => {
  const len = Math.max(0.5, b.t1 - b.t0);
  return `between(${Tz},${b.t0.toFixed(3)},${(b.t1 - 0.001).toFixed(3)})*(${(i % 2 ? ST.jump : 0).toFixed(3)}+${ST.push}*(${Tz}-${b.t0.toFixed(3)})/${len.toFixed(3)})`;
}).join("+") || "0";
const kset = new Set((plan.keywords || []).map((k) => String(k)));
const norm = (t) => String(t).replace(/[\p{P}\p{S} ]/gu, "").trim();
let lastK = -9;
const kws = tr.words.filter((w) => w.t0 < D - 0.3 && kset.has(norm(w.w))).filter((w) => (w.t0 - lastK > 1.6 ? (lastK = w.t0, true) : false)).slice(0, SAFE ? 0 : 50);
const kwTerm = kws.map((w) => `if(gte(${Tz},${w.t0.toFixed(3)}),0.03*exp(-7*(${Tz}-${w.t0.toFixed(3)})),0)`).join("+") || "0";
const trans = beats.slice(1).map((b) => b.t0).filter((t) => t < CTA_START);
const shakeTerm = ST.glitch === "shake" && trans.length ? trans.map((t) => `between(${Tz},${t.toFixed(3)},${(t + 0.2).toFixed(3)})*14*sin(95*${Tz})`).join("+") : "0";
const OS = 1.2; // marge de zoom
const iw2 = Math.round((W * OS) / 2) * 2, ih2 = Math.round((H * OS) / 2) * 2;

// ---------- graphe ffmpeg ----------
writeFileSync(`${CONTENT_DIR}/short.ass`, ass.toString());
const inputs = [];
const addInput = (a) => { inputs.push(...a); return inputs.filter((x) => x === "-i").length - 1; };
const iSrc = addInput(["-i", videoPath]);
let iLogo = -1, iLM = -1;
function circleMask(s) {
  const out = `assets/mask-circle-${s}.png`;
  if (!existsSync(out)) execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=white:s=${s}x${s}:d=1,format=gray,geq=lum='clip(255*(${s / 2}-hypot(X-${s / 2},Y-${s / 2}))+128,0,255)'`, "-frames:v", "1", out]);
  return out;
}
if (logoFile) { iLogo = addInput(["-loop", "1", "-framerate", String(FPS), "-i", logoFile]); iLM = addInput(["-loop", "1", "-framerate", String(FPS), "-i", circleMask(LOGO)]); }
const sfxIdx = {};
for (const [k, f] of Object.entries(SFX)) sfxIdx[k] = addInput(["-i", f]);
const usable = SAFE ? [] : emojiOverlays.filter((e) => existsSync(e.file));
const emoIdx = usable.map((e) => addInput(["-loop", "1", "-framerate", String(FPS), "-t", Math.max(0.2, e.t1 - e.t0 + 0.1).toFixed(3), "-i", e.file]));

const f = [];
let v = `[${iSrc}:v]setpts=PTS-STARTPTS,fps=${FPS},setsar=1${padSec > 0.5 ? `,tpad=stop_mode=clone:stop_duration=${(padSec + 1).toFixed(2)}` : ""}`;
v += `,scale=${iw2}:${ih2}:force_original_aspect_ratio=increase,crop=${iw2}:${ih2}`;
v += `,zoompan=z='1+${beatTerm}+${kwTerm}':x='iw/2-iw/zoom/2+(${shakeTerm})':y='ih/2-ih/zoom/2+(${shakeTerm})*0.5':d=1:s=${W}x${H}:fps=${FPS}`;
if (ST.vignette) v += `,vignette=angle=PI/6`;
if (ST.glitch === "rgb" && trans.length && !SAFE) v += `,rgbashift=rh=14:bh=-14:gv=4:enable='${trans.map((t) => `between(t,${t.toFixed(3)},${(t + 0.14).toFixed(3)})`).join("+")}'`;
f.push(`${v},format=yuv420p[base]`);
let last = "base";
f.push(`[${last}]ass=${CONTENT_DIR}/short.ass:fontsdir=fonts[oa]`); last = "oa";
if (logoFile) {
  const lx = rtl ? W - 40 - LOGO : 40, ly = Math.round(TAG.y + (TAG.h - LOGO) / 2);
  f.push(`[${iLogo}:v]scale=${LOGO}:${LOGO},format=yuva420p[lg0]`, `[${iLM}:v]format=gray[lm]`, `[lg0][lm]alphamerge[lg]`);
  f.push(`[${last}][lg]overlay=${lx}:${ly}:enable='gte(t,${HOOK_END.toFixed(2)})'[ol]`); last = "ol";
}
usable.forEach((e, k) => {
  const len = Math.max(0.2, e.t1 - e.t0);
  f.push(`[${emoIdx[k]}:v]scale=${e.size}:${e.size},format=rgba,fade=in:st=0:d=0.12:alpha=1,fade=out:st=${Math.max(0, len - 0.2).toFixed(3)}:d=0.2:alpha=1,setpts=PTS-STARTPTS+${e.t0.toFixed(3)}/TB[e${k}]`);
  const T0 = e.t0.toFixed(3);
  f.push(`[${last}][e${k}]overlay=x='${Math.round(e.x)}':y='${Math.round(e.y)}-26*abs(sin(6*(t-${T0})))*exp(-1.5*(t-${T0}))':eof_action=pass:enable='between(t,${T0},${e.t1.toFixed(3)})'[oe${k}]`);
  last = `oe${k}`;
});
f.push(`[${last}]format=yuv420p[vout]`);
const byType = {};
sfxEvents.forEach((e, n) => (byType[e.type] ||= []).push({ ...e, n }));
const sl = [];
for (const [type, evs] of Object.entries(byType)) {
  const labels = evs.map((e) => `[x${e.n}]`);
  f.push(evs.length === 1 ? `[${sfxIdx[type]}:a]anull${labels[0]}` : `[${sfxIdx[type]}:a]asplit=${evs.length}${labels.join("")}`);
  evs.forEach((e) => { const ms = Math.max(0, Math.round(e.t * 1000)); f.push(`[x${e.n}]adelay=${ms}|${ms},volume=${e.v}[y${e.n}]`); sl.push(`[y${e.n}]`); });
}
f.push(`${sl.join("")}amix=inputs=${sl.length}:normalize=0:duration=longest,aresample=48000,aformat=channel_layouts=stereo[sfx]`);
if (info.hasAudio) {
  f.push(`[${iSrc}:a]asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo[voice]`);
  f.push(`[voice][sfx]amix=inputs=2:normalize=0:duration=first,apad=whole_dur=${D.toFixed(3)},afade=t=out:st=${Math.max(0, D - 0.25).toFixed(3)}:d=0.25,alimiter=limit=0.96[aout]`);
} else f.push(`[sfx]apad,alimiter=limit=0.96[aout]`);
writeFileSync(`${CONTENT_DIR}/short-filter.txt`, f.join(";\n"));

const out = `${OUTPUT_DIR}/final.mp4`;
const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", ...inputs, "-filter_complex_script", `${CONTENT_DIR}/short-filter.txt`,
  "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", process.env.X264_PRESET || "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", D.toFixed(3), out];
console.log("Rendu ffmpeg en cours...");
execFileSync("ffmpeg", args, { stdio: "inherit" });
const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", out]).toString());
const vd = Number(j.streams.find((x) => x.codec_type === "video")?.duration) || 0;
console.log(`Vérification : vidéo ${vd.toFixed(1)} s (attendu ${D.toFixed(1)} s)`);
if (vd < D - 1) throw new Error(`Short trop court (${vd.toFixed(1)} s au lieu de ${D.toFixed(1)} s)`);
console.log(`✔ ${out}`);
