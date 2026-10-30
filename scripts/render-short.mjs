// scripts/render-short.mjs — rendu d'un SHORT (workflow « Video to Shorts »). Identité visuelle volontairement
// DIFFÉRENTE de Build Video (render-video.mjs) :
//   • vidéo PLEIN ÉCRAN (aucune fenêtre, aucun cadre néon, aucun fond flouté) avec "jump-zoom" à chaque idée et
//     lente poussée de caméra, micro-zooms sur les mots-clés ;
//   • transitions "glitch" (décalage RVB) ou "secousse" — jamais de flash ni de rideau ;
//   • sous-titres KARAOKÉ gros caractères condensés (Anton / Lalezar), mot actif sur boîte, en couleur ou souligné ;
//   • ÉTIQUETTE DE CHAPITRE inclinée façon tampon (au lieu du bandeau de headline) + emoji réaction ;
//   • PUCES (chips) qui s'empilent (au lieu des cartes split-screen) ;
//   • barre de progression SEGMENTÉE (une case par idée, façon stories) ;
//   • badge « extrait — vidéo complète en lien » après le hook ;
//   • ÉCRAN DE FIN : la vidéo se réduit en carte en haut (visage entier visible), en bas « S'ABONNER » cliqué par une
//     main + cloche + « J'AIME » qui éclate, et « VIDÉO COMPLÈTE ↓ lien juste en dessous » en grand — dans la zone
//     visible au-dessus de l'interface YouTube, sans rien poser sur le visage ;
//   • sons propres (swish, clics, boom, montée, ding, pop).
// Aucun texte sur le visage ni sur des sous-titres déjà incrustés (content/face.json, scripts/face-box.py), et rien
// dans les zones couvertes par l'interface YouTube Shorts / TikTok / Reels.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { CONTENT_DIR, OUTPUT_DIR, findVideo, probeVideo, listFontFiles } from "./lib/util.mjs";
import { Ass, c1, c3, c4, rrect, esc } from "./lib/ass.mjs";
import { measureTokens } from "./lib/measure.mjs";
import { shortStyle } from "./lib/short-styles.mjs";
import { channelFor, burnedLogo } from "./lib/channel.mjs";

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
const LBL = {
  fr: { sub: "S'ABONNER", subbed: "ABONNÉ", like: "J'AIME" }, en: { sub: "SUBSCRIBE", subbed: "SUBSCRIBED", like: "LIKE" },
  it: { sub: "ISCRIVITI", subbed: "ISCRITTO", like: "MI PIACE" }, ar: { sub: "اشترك", subbed: "تم الاشتراك", like: "أعجبني" },
}[lang] || { sub: "S'ABONNER", subbed: "ABONNÉ", like: "J'AIME" };
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
const allTok = new Set(["●", "|"]);
[plan.hook && up(plan.hook), T_.badge, up(T_.cta1), T_.cta2, up(LBL.sub), up(LBL.subbed), up(LBL.like),
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
let SHIFT = 0; // descente de la vidéo (px) quand il n'y a pas assez de place hors visage pour les textes
const fy = (v, z) => SHIFT + H / 2 + (v - 0.5) * srcH * z;
let face = { found: false, y0: 0.08, y1: 0.56 }, caps = null;
try { const f = JSON.parse(readFileSync(`${CONTENT_DIR}/face.json`, "utf8")); if (f.found) face = f; caps = f.captions || null; } catch {}
const bandOf = (b) => ({ y0: Math.min(fy(b.y0, Zmax), fy(b.y0, 1)) - 16, y1: Math.max(fy(b.y1, Zmax), fy(b.y1, 1)) + 16 });
const autoSubsOff = !!caps && !process.env.SUBTITLES;
let subsOn = !autoSubsOff && String(process.env.SUBTITLES || "full") !== "off";
// source déjà verticale (montage de Montage LV final, déjà mis en page) : la vidéo n'est JAMAIS déplacée ni coupée
const VERT = info.height >= info.width * 1.4;
// place nécessaire : sous-titres (150) + étiquette (120) + marges
const NEED = (subsOn ? 160 : 0) + 140;
let prot, gaps;
function computeGaps() {
  prot = [{ what: "visage", ...bandOf(face) }];
  if (caps) prot.push({ what: "sous-titres incrustés", ...bandOf(caps) });
  gaps = [{ y0: SAFE_TOP, y1: SAFE_BOT }];
  for (const p of prot) gaps = gaps.flatMap((g) => [{ y0: g.y0, y1: Math.min(g.y1, p.y0) }, { y0: Math.max(g.y0, p.y1), y1: g.y1 }]).filter((g) => g.y1 - g.y0 > 40);
}
computeGaps();
{
  // chaque élément a besoin d'une bande d'un seul tenant : on regarde la place réellement utilisable
  // on descend la vidéo par paliers jusqu'à obtenir la place nécessaire (au plus 760 px : la vidéo reste à ≈ 60 %)
  const usable = () => gaps.reduce((n, g) => n + (g.y1 - g.y0 >= 86 ? g.y1 - g.y0 : 0), 0);
  if (VERT) console.log("Source verticale : vidéo entière, jamais déplacée (les textes se placent autour du visage).");
  else if (usable() < NEED) {
    for (let sft = 40; sft <= 760; sft += 40) { SHIFT = sft; computeGaps(); if (usable() >= NEED) break; }
    console.log(`Peu de place hors visage : la vidéo descend de ${SHIFT} px (bandeau flou en haut) pour loger les textes sans toucher le visage.`);
  }
}
prot.forEach((p) => console.log(`Zone protégée (${p.what}${p.what === "visage" && !face.found ? ", position par défaut" : ""}) : y ${Math.round(p.y0)}→${Math.round(p.y1)}`));
const room = (g) => g.y1 - g.y0;
const take = (g, h, fromBottom) => { const y = fromBottom ? g.y1 - h : g.y0; if (fromBottom) g.y1 -= h + 10; else g.y0 += h + 10; return y; };
const lowest = (min) => gaps.filter((g) => room(g) >= min).sort((a, b) => b.y1 - a.y1)[0];
const faceMid = (prot[0].y0 + prot[0].y1) / 2;
// Ordre de priorité : 1) étiquettes (toujours), 2) puces (toujours), 3) accroche / badge, 4) sous-titres en DERNIER
// (retirés s'il ne reste pas de place). Jamais rien sur le visage. S'il n'y a pas de zone totalement libre, étiquettes
// et puces se posent sur le reste de l'image (sous-titres incrustés du montage, cadre photo / article) : leur fond est
// opaque, elles restent lisibles.
const reserve = (y0, y1) => { gaps = gaps.flatMap((g) => [{ y0: g.y0, y1: Math.min(g.y1, y0 - 10) }, { y0: Math.max(g.y0, y1 + 10), y1: g.y1 }]).filter((g) => g.y1 - g.y0 > 40); };
const RES = [];   // zones déjà prises (pour les zones de repli)
const faceFree = () => {  // bandes hors visage seulement (on accepte de couvrir le reste de l'image)
  let g = [{ y0: SAFE_TOP, y1: SAFE_BOT }];
  for (const p of [prot[0], ...RES]) g = g.flatMap((x) => [{ y0: x.y0, y1: Math.min(x.y1, p.y0 - 10) }, { y0: Math.max(x.y0, p.y1 + 10), y1: x.y1 }]).filter((x) => x.y1 - x.y0 > 40);
  return g;
};
const FORCED = [];
// 1) étiquette de chapitre
const above = gaps.filter((g) => g.y1 <= faceMid && room(g) >= 110).sort((a, b) => room(b) - room(a))[0];
let gT = above || gaps.filter((g) => room(g) >= 100).sort((a, b) => room(b) - room(a))[0];
let TAG;
if (gT) { const h = Math.min(130, room(gT)); TAG = { y: gT === above ? gT.y0 : gT.y1 - h, h }; }
else {
  const f = faceFree().sort((a, b) => room(b) - room(a))[0];
  // étiquette un peu plus compacte (100 px) pour laisser aussi la place aux puces
  if (f) { const h = Math.max(70, Math.min(100, room(f))); TAG = { y: f.y1 <= faceMid ? f.y0 : f.y1 - h, h }; }
  else TAG = { y: SAFE_TOP, h: 80 };   // visage plein cadre : tout en haut, en petit
  FORCED.push("étiquettes");
}
const NO_TAG = false;
RES.push({ y0: TAG.y, y1: TAG.y + TAG.h }); reserve(TAG.y, TAG.y + TAG.h);
// 2) puces
let gC = gaps.filter((g) => room(g) >= 190).sort((a, b) => room(b) - room(a))[0];
if (!gC) { gC = faceFree().filter((g) => room(g) >= 90).sort((a, b) => room(b) - room(a))[0]; if (gC) FORCED.push("puces"); }
const CHIPS = gC ? { y0: gC.y0, y1: Math.min(gC.y1, gC.y0 + 320) } : null;
if (CHIPS) { RES.push(CHIPS); reserve(CHIPS.y0, CHIPS.y1); }
// 3) sous-titres : en dernier, seulement s'il reste une place libre
const CAP_H = 150;
let CAP_Y = SAFE_BOT - CAP_H / 2 - 10;
if (subsOn) {
  const g = lowest(CAP_H);
  if (g) CAP_Y = take(g, CAP_H, true) + CAP_H / 2;
  else { subsOn = false; console.log("Sous-titres du short retirés : plus de place libre après les étiquettes et les puces (priorité aux étiquettes)."); }
}
if (autoSubsOff) console.log("Sous-titres déjà incrustés dans la vidéo : nos sous-titres sont désactivés.");
if (FORCED.length) console.log(`Pas de zone totalement libre : ${FORCED.join(" et ")} posées sur le reste de l'image (fond opaque), jamais sur le visage.`);
// 5) hook / badge / carte de fin : la plus grande zone disponible autour de l'étiquette
const near = CHIPS && Math.abs(CHIPS.y0 - (TAG.y + TAG.h)) < 30;
const BIG = near ? { y0: TAG.y, y1: CHIPS.y1 } : CHIPS && CHIPS.y1 - CHIPS.y0 > TAG.h ? CHIPS : { y0: TAG.y, y1: TAG.y + TAG.h };
console.log(`Zones : étiquette y=${Math.round(TAG.y)} h=${Math.round(TAG.h)}, ${CHIPS ? `puces y=${Math.round(CHIPS.y0)}→${Math.round(CHIPS.y1)}` : "pas de puces (pas de place hors visage)"}, ${subsOn ? `sous-titres y≈${Math.round(CAP_Y)}` : "sans sous-titres"}`);
// CONTRÔLE : aucune zone de texte ne doit en toucher une autre, ni le visage / les sous-titres incrustés
{
  const boxes = [];
  if (!NO_TAG) boxes.push({ n: "étiquette", y0: TAG.y, y1: TAG.y + TAG.h });
  if (subsOn) boxes.push({ n: "sous-titres", y0: CAP_Y - CAP_H / 2, y1: CAP_Y + CAP_H / 2 });
  if (CHIPS) boxes.push({ n: "puces", y0: CHIPS.y0, y1: CHIPS.y1 });
  const hit = [];
  boxes.forEach((a, i) => { boxes.slice(i + 1).forEach((b) => { if (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 2) hit.push(`${a.n}/${b.n}`); });
    prot.forEach((p) => { if (Math.min(a.y1, p.y1) - Math.max(a.y0, p.y0) > 2 && !(p.what !== "visage" && FORCED.length)) hit.push(`${a.n}/${p.what}`); }); });
  console.log(hit.length ? `⚠ Superpositions détectées : ${hit.join(", ")}` : "✔ Contrôle mise en page : aucune superposition (textes / visage)");
}
if (process.env.LAYOUT_ONLY) process.exit(0); // test rapide de la mise en page

// ---------- timeline ----------
const beats = plan.beats.filter((b) => b.t0 < D - 0.3).map((b) => ({ ...b, t1: Math.min(b.t1, D) }));
const HOOK_END = plan.hook ? Math.min(3.0, D * 0.3) : 0.2;
// écran de fin (abonnement + j'aime + vidéo complète)
const END_LEN = Math.min(5, Math.max(3.6, D * 0.1));
const CTA_START = Math.max(HOOK_END + 2, D - END_LEN);
// badge « extrait » : dans la zone des puces s'il y en a une, sinon à la place de la 1re étiquette (qui attend)
const BADGE = { t0: HOOK_END + 0.1, t1: Math.min(HOOK_END + 3.2, CTA_START - 0.3) };
const BADGE_IN_TAG = !CHIPS || NO_TAG;
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
// logo = chaîne de la LANGUE du short (jamais le logo d'une autre langue) ; source verticale venant de Montage LV final
// avec son petit logo déjà incrusté → pas de 2e petit logo (le grand logo de fin reste)
const CH = channelFor(lang);
const BURNED = burnedLogo(videoPath);
const logoFile = CH.logo;
const tagLogo = !!logoFile && !(BURNED && BURNED.orient === "v" && info.height > info.width);
console.log(`Logo : ${CH.why}${logoFile && !tagLogo ? " — petit logo déjà incrusté par le montage : pas de doublon" : ""}`);
if (CH.why.startsWith("⚠")) console.log(`::warning::${CH.why}`);
const LOGO = Math.round(Math.min(96, TAG.h - 12));
const tagX0 = tagLogo ? 40 + LOGO + 16 : 50;
const tagMaxW = W - tagX0 - 50;
function tagShape(w, h) {
  if (ST.tagShape === "pill") return rrect(w, h, h / 2);
  if (ST.tagShape === "slant") return `m 22 0 l ${w} 0 l ${w - 22} ${h} l 0 ${h}`;
  return rrect(w, h, 8);
}
beats.forEach((b, i) => {
  if (!b.headline || NO_TAG) return;
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

// 7) sous-titres karaoké
if (subsOn) {
  const em = rtl ? 74 : 84;
  const words = tr.words.filter((w) => w.t0 < CTA_START - 0.1 && (!NO_TAG || w.t0 >= TAG_FROM)); // fin : masqués
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
      let t1 = Math.min(CTA_START, i < ph.length - 1 ? ph[i + 1].t0 : Math.min(w.t1 + 0.2, next - 0.03));
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

// 8) ÉCRAN DE FIN : carte vidéo en haut, abonnement + j'aime + vidéo complète en bas (zone visible au-dessus de
//    l'interface YouTube : ni sous le titre/la chaîne en bas, ni sous la colonne de boutons à droite)
const EK = 0.46; // taille de la carte vidéo
const CARD = { w: Math.round((W * EK) / 2) * 2, h: Math.round((H * EK) / 2) * 2 };
CARD.x = Math.round((W - CARD.w) / 2); CARD.y = 140;
const ET = CTA_START;
const END = (() => {
  const top = CARD.y + CARD.h + 22, bot = SAFE_BOT;
  const subH = 96;
  return { subY: top, subH, ctaY0: top + subH + 18, ctaY1: bot };
})();
const TAP = ET + 1.15, LIKE = ET + 1.75;
if (D - ET > 2) {
  // cadre de la carte vidéo
  ass.add(40, ET + 0.05, D, `{\\an7\\pos(${CARD.x - 6},${CARD.y - 6})\\1a&HFF&\\bord6${c3(P.accent)}\\shad0\\fad(250,0)\\p1}${rrect(CARD.w + 12, CARD.h + 12, 30)}{\\p0}`);
  // bouton S'ABONNER → (main qui clique) → ABONNÉ ✓ + cloche
  const em = rtl ? 40 : 44;
  const sw = Math.max(lineW(up(LBL.sub), em), lineW(up(LBL.subbed), em) + 46) + 70, sh = END.subH;
  const LOGO_E = logoFile ? 84 : 0;
  const rowW = LOGO_E + (LOGO_E ? 18 : 0) + sw + 40 + 150;
  const rx = Math.round((W - 120 - rowW) / 2) + 20; // un peu à gauche du centre : la colonne de boutons YouTube est à droite
  const sx = rx + (LOGO_E ? LOGO_E + 18 : 0), sy = END.subY;
  END.logo = LOGO_E ? { x: rx, y: Math.round(sy + (sh - LOGO_E) / 2), s: LOGO_E } : null;
  const pop = `\\fscx0\\fscy0\\t(0,200,\\fscx108\\fscy108)\\t(200,300,\\fscx100\\fscy100)`;
  const org = `\\org(${Math.round(sx + sw / 2)},${Math.round(sy + sh / 2)})`;
  ass.add(41, ET + 0.3, TAP, `{\\an7\\pos(${sx},${sy})\\bord0\\shad6${c4("#000000", 0.4)}${c1("#E8192C")}${org}${pop}\\t(${Math.round((TAP - ET - 0.3) * 1000) - 120},${Math.round((TAP - ET - 0.3) * 1000)},\\fscx92\\fscy92)\\p1}${rrect(sw, sh, sh / 2)}{\\p0}`);
  ass.add(42, ET + 0.35, TAP, `{\\an5\\pos(${Math.round(sx + sw / 2)},${Math.round(sy + sh / 2)})\\fs${fsz(em)}\\bord0\\shad0${c1("#FFFFFF")}${org}${pop}}${up(LBL.sub)}`);
  ass.add(41, TAP, D, `{\\an7\\pos(${sx},${sy})\\bord0\\shad6${c4("#000000", 0.4)}${c1("#3A3A3A")}${org}\\fscx92\\fscy92\\t(0,160,\\fscx104\\fscy104)\\t(160,260,\\fscx100\\fscy100)\\p1}${rrect(sw, sh, sh / 2)}{\\p0}`);
  const ck = `m 0 14 l 8 6 l 18 16 l 36 -2 l 44 6 l 18 32`;
  ass.add(42, TAP, D, `{\\an7\\pos(${Math.round(sx + 30)},${Math.round(sy + sh / 2 - 15)})\\bord0\\shad0${c1(P.accent)}\\fscx0\\fscy0\\t(60,220,\\fscx70\\fscy70)\\p1}${ck}{\\p0}`);
  ass.add(42, TAP, D, `{\\an5\\pos(${Math.round(sx + sw / 2 + 22)},${Math.round(sy + sh / 2)})\\fs${fsz(em)}\\bord0\\shad0${c1("#FFFFFF")}${org}}${up(LBL.subbed)}`);
  // ondes du clic
  [0, 1].forEach((k) => ass.add(43, TAP + k * 0.08, TAP + 0.6, `{\\an5\\pos(${Math.round(sx + sw * 0.62)},${Math.round(sy + sh * 0.62)})\\1a&HFF&\\bord4${c3("#FFFFFF")}\\shad0\\fscx20\\fscy20\\t(0,500,\\fscx${160 + k * 60}\\fscy${160 + k * 60}\\3a&HFF&)\\p1}m -30 0 b -30 -17 -17 -30 0 -30 b 17 -30 30 -17 30 0 b 30 17 17 30 0 30 b -17 30 -30 17 -30 0{\\p0}`));
  // main qui vient cliquer, cloche qui sonne, pouce « j'aime » qui éclate
  emojiOverlays.push({ file: "assets/emoji/1f446.png", kind: "hand", t0: ET + 0.55, t1: TAP + 0.45, x: sx + sw * 0.62 - 40, y: sy + sh * 0.62 - 10, size: 96, from: { dx: 240, dy: 260 }, arrive: TAP - 0.05 });
  emojiOverlays.push({ file: "assets/emoji/1f514.png", kind: "bell", t0: TAP + 0.1, t1: D, x: sx + sw + 18, y: sy + (sh - 84) / 2, size: 84 });
  const lx = sx + sw + 18 + 84 + 26, ly = sy - 8;
  emojiOverlays.push({ file: "assets/emoji/1f44d.png", kind: "like", t0: LIKE, t1: D, x: lx, y: ly, size: 112 });
  for (let k = 0; k < 10; k++) { // éclats autour du pouce
    const a = (k / 10) * Math.PI * 2, cx = lx + 56, cy = ly + 56;
    ass.add(43, LIKE + 0.05, LIKE + 0.75, `{\\an5\\move(${cx},${cy},${Math.round(cx + Math.cos(a) * 110)},${Math.round(cy + Math.sin(a) * 110)},0,450)\\bord0\\shad0${c1(k % 2 ? P.accent : "#FFFFFF")}\\fad(0,300)\\p1}m -7 0 b -7 -4 -4 -7 0 -7 b 4 -7 7 -4 7 0 b 7 4 4 7 0 7 b -4 7 -7 4 -7 0{\\p0}`);
  }
  ass.add(43, LIKE + 0.1, D, `{\\an8\\pos(${Math.round(lx + 56)},${Math.round(ly + 112)})\\fs${fsz(24)}\\bord3${c3("#000000")}\\shad0${c1("#FFFFFF")}\\fad(150,0)}${up(LBL.like)}`);
  // VIDÉO COMPLÈTE ↓ lien juste en dessous — en grand, en bas
  const zone = END.ctaY1 - END.ctaY0;
  const e1 = Math.round(Math.min(92, Math.max(40, (zone - 30) / (LF * 1.45)))), e2 = Math.round(e1 * 0.5);
  const l1 = up(T_.cta1), w1 = Math.min(W - 160, lineW(l1, e1) + 80), h1 = lh(e1) * 0.9 + 22;
  const cxC = W / 2 - 40;
  const y1 = END.ctaY0 + (zone - (h1 + lh(e2) * 1.0)) / 2;
  const orgC = `\\org(${Math.round(cxC)},${Math.round(y1 + h1 / 2)})`;
  const stamp = `${orgC}\\frz${ST.tagTilt}\\fscx0\\fscy0\\t(0,180,\\fscx110\\fscy110)\\t(180,300,\\fscx100\\fscy100)`;
  ass.add(44, ET + 0.5, D, `{\\an7\\pos(${Math.round(cxC - w1 / 2)},${Math.round(y1)})\\bord0\\shad8${c4("#000000", 0.5)}${c1(P.accent)}${stamp}\\p1}${tagShape(w1, h1)}{\\p0}`);
  for (const g of lineGeom(l1, e1, cxC)) ass.add(45, ET + 0.55, D, `{\\an5\\pos(${Math.round(g.xc)},${Math.round(y1 + h1 / 2)})\\fs${fsz(e1)}\\bord0\\shad0${c1(P.accentText)}${stamp}}${g.t}`);
  const y2 = y1 + h1 + lh(e2) * 0.55, w2 = lineW(T_.cta2, e2);
  ass.add(45, ET + 0.8, D, `{\\an5\\pos(${Math.round(cxC - 24)},${Math.round(y2)})\\fs${fsz(e2)}\\bord5${c3("#000000")}\\shad0${c1("#FFFFFF")}\\fad(200,0)}${T_.cta2}`);
  const cs = Math.max(14, Math.round(e2 * 0.45)), ax = Math.round(cxC - 24 + w2 / 2 + 20);
  const chev = `m 0 0 l ${cs} ${cs * 0.75} l ${cs * 2} 0 l ${cs * 2} ${cs * 0.4} l ${cs} ${cs * 1.15} l 0 ${cs * 0.4}`;
  [0, 1].forEach((k) => {
    const yy = Math.round(y2 - cs * 0.9 + k * cs * 0.85);
    const blink = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => `\\t(${j * 300},${j * 300 + 150},\\1a&H${k ? "60" : "00"}&)\\t(${j * 300 + 150},${j * 300 + 300},\\1a&H${k ? "C0" : "90"}&)`).join("");
    ass.add(45, ET + 0.95 + k * 0.12, D, `{\\an7\\pos(${ax},${yy})\\bord3${c3("#000000")}\\shad0${c1(P.accent)}${blink}\\p1}${chev}{\\p0}`);
  });
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
  ding: synth(`ding-${ST.sfx}`, `aevalsrc='0.5*exp(-4*t)*(sin(2*PI*${Math.round(V.ck * 0.6)}*t)+0.6*sin(2*PI*${Math.round(V.ck * 0.9)}*t))':d=0.9:s=48000`),
  pop: synth(`pop-${ST.sfx}`, `aevalsrc='0.8*exp(-18*t)*sin(2*PI*(380+900*t)*t)':d=0.25:s=48000`),
  sparkle: synth(`sparkle-${ST.sfx}`, `aevalsrc='0.25*exp(-5*t)*sin(2*PI*(1800+2600*mod(floor(t*16),4)/3)*t)':d=0.6:s=48000`),
  riser: synth(`riser-${ST.sfx}`, `aevalsrc='0.35*sin(2*PI*(${V.rs}+${V.rs * 2}*t)*t)':d=1.1:s=48000,afade=t=in:d=0.6,afade=t=out:st=0.95:d=0.15`),
};
const sfxEvents = [{ type: "boom", t: 0.05, v: 0.8 }];
beats.forEach((b, i) => { if (i > 0 && b.t0 < CTA_START) sfxEvents.push({ type: "swish", t: b.t0 - 0.05, v: 0.5 }); if (b.headline && b.t0 < CTA_START) sfxEvents.push({ type: "click", t: Math.max(b.t0, HOOK_END), v: 0.45 }); });
if (D - CTA_START > 2) {
  sfxEvents.push({ type: "riser", t: Math.max(0, CTA_START - 1.05), v: 0.45 }, { type: "swish", t: CTA_START, v: 0.6 });
  sfxEvents.push({ type: "click", t: TAP - 0.02, v: 0.9 }, { type: "ding", t: TAP + 0.12, v: 0.6 }, { type: "pop", t: LIKE, v: 0.8 }, { type: "sparkle", t: LIKE + 0.06, v: 0.55 });
}

// ---------- caméra : plein écran, jump-zoom par idée, poussée lente, micro-zooms sur les mots-clés ----------
const Tz = `(on/${FPS})`;
// RELANCES D'ATTENTION : le cadrage change (alternance plan large / serré) à chaque coupe de silence et à chaque
// nouvelle phrase — au plus toutes les 1,8 s — : les coupes deviennent des « jump cuts » rythmés, jamais un saut brut.
const cutPts = (tr.cuts || []).filter((t) => t > 0.5 && t < CTA_START - 0.5);
const sentPts = tr.words.filter((w, i) => i > 0 && (/[.!?؟…]$/.test(tr.words[i - 1].w) || w.t0 - tr.words[i - 1].t1 > 0.35)).map((w) => w.t0);
const switchPts = [...new Set([...cutPts, ...sentPts].map((t) => +t.toFixed(2)))].sort((a, b) => a - b)
  .filter((t) => t > HOOK_END - 0.2 && t < CTA_START - 0.3)
  .reduce((acc, t) => (acc.length && t - acc[acc.length - 1] < 1.8 ? acc : [...acc, t]), []);
const shots = [0, ...switchPts, D].map((t, i, arr) => (i < arr.length - 1 ? { t0: t, t1: arr[i + 1], z: i % 2 ? ST.jump : 0 } : null)).filter(Boolean).slice(0, 90);
const jumpTerm = shots.filter((x) => x.z).map((x) => `between(${Tz},${x.t0.toFixed(3)},${(x.t1 - 0.001).toFixed(3)})*${x.z.toFixed(3)}`).join("+") || "0";
// lente poussée de caméra dans chaque idée
const pushTerm = beats.map((b) => {
  const len = Math.max(0.5, b.t1 - b.t0);
  return `between(${Tz},${b.t0.toFixed(3)},${(b.t1 - 0.001).toFixed(3)})*${ST.push}*(${Tz}-${b.t0.toFixed(3)})/${len.toFixed(3)}`;
}).join("+") || "0";
const beatTerm = `${jumpTerm}+${pushTerm}`;
console.log(`Relances : ${shots.length} plans (changement de cadrage toutes les ${(D / Math.max(1, shots.length)).toFixed(1)} s en moyenne), ${cutPts.length} coupes de silence masquées`);
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
// durée bornée (-t) : une branche inutilisée (nullsink) ne doit jamais tourner sans fin
if (logoFile) { iLogo = addInput(["-loop", "1", "-framerate", String(FPS), "-t", (D + 1).toFixed(2), "-i", logoFile]); iLM = addInput(["-loop", "1", "-framerate", String(FPS), "-t", (D + 1).toFixed(2), "-i", circleMask(LOGO)]); }
function roundMask(w, h, r) {
  const out = `assets/mask-short-${w}x${h}-r${r}.png`;
  const ix = `max(max(${r}-X,X-(${w - 1}-${r})),0)`, iy = `max(max(${r}-Y,Y-(${h - 1}-${r})),0)`;
  if (!existsSync(out)) execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=white:s=${w}x${h}:d=1,format=gray,geq=lum='clip(255*(${r}-sqrt(pow(${ix},2)+pow(${iy},2)))+128,0,255)'`, "-frames:v", "1", out]);
  return out;
}
const iCM = D - CTA_START > 2 ? addInput(["-loop", "1", "-framerate", String(FPS), "-i", roundMask(CARD.w, CARD.h, 28)]) : -1;
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
if (SHIFT > 0) {
  f.push(`${v},format=yuv420p,split=2[fg][bgsrc]`);
  // bandeau du haut : copie très floutée et assombrie de la vidéo (la vidéo nette commence en dessous)
  f.push(`[bgsrc]scale=${Math.round(W / 6 / 2) * 2}:${Math.round(H / 6 / 2) * 2},gblur=sigma=6,eq=brightness=-0.28:saturation=1.3,scale=${W}:${H}[bgb]`);
  f.push(`[bgb][fg]overlay=0:${SHIFT}:shortest=1,format=yuv420p[base]`);
} else f.push(`${v},format=yuv420p[base]`);
if (D - CTA_START > 2) {
  // écran de fin : la vidéo devient une carte arrondie en haut, sur un fond flou assombri
  const em = 0.35; // durée de la mise en place (s)
  f.push(`[base]split=3[bm][bb][bc]`);
  f.push(`[bb]scale=${Math.round(W / 8 / 2) * 2}:${Math.round(H / 8 / 2) * 2},gblur=sigma=4,eq=brightness=-0.32:saturation=1.2,scale=${W}:${H}[eb]`);
  f.push(`[bc]scale=${CARD.w}:${CARD.h},format=yuva420p[cc0]`, `[${iCM}:v]format=gray[cm]`, `[cc0][cm]alphamerge[cc]`);
  f.push(`[eb][cc]overlay=x=${CARD.x}:y='${CARD.y}+60*max(0,1-(t-${ET.toFixed(3)})/${em})'[endc]`);
  f.push(`[bm][endc]overlay=0:0:enable='gte(t,${ET.toFixed(3)})'[base2]`);
} else f.push(`[base]null[base2]`);
let last = "base2";
f.push(`[base2]ass=${CONTENT_DIR}/short.ass:fontsdir=fonts[oa]`); last = "oa";
if (logoFile) {
  const lx = rtl ? W - 40 - LOGO : 40, ly = Math.round(TAG.y + (TAG.h - LOGO) / 2);
  // logo jamais déformé : ramené dans un carré (bandes transparentes) avant le masque rond
  f.push(`[${iLogo}:v]format=rgba,scale=${LOGO}:${LOGO}:force_original_aspect_ratio=decrease,pad=${LOGO}:${LOGO}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p[lg0]`, `[${iLM}:v]format=gray[lm]`, `[lg0][lm]alphamerge[lg]`);
  f.push(`[lg]split=2[lg1][lg2]`);
  if (tagLogo) { f.push(`[${last}][lg1]overlay=${lx}:${ly}:enable='between(t,${HOOK_END.toFixed(2)},${CTA_START.toFixed(2)})'[ol]`); last = "ol"; }
  else f.push(`[lg1]nullsink`);
  if (END.logo && D - CTA_START > 2) { f.push(`[lg2]scale=${END.logo.s}:${END.logo.s}[lg3]`, `[${last}][lg3]overlay=${END.logo.x}:${END.logo.y}:enable='gte(t,${(ET + 0.3).toFixed(2)})'[ol2]`); last = "ol2"; }
  else f.push(`[lg2]nullsink`);
}
usable.forEach((e, k) => {
  const len = Math.max(0.2, e.t1 - e.t0);
  f.push(`[${emoIdx[k]}:v]scale=${e.size}:${e.size},format=rgba,fade=in:st=0:d=0.12:alpha=1,fade=out:st=${Math.max(0, len - 0.2).toFixed(3)}:d=0.2:alpha=1,setpts=PTS-STARTPTS+${e.t0.toFixed(3)}/TB[e${k}]`);
  const T0 = e.t0.toFixed(3);
  let ex = `${Math.round(e.x)}`, ey = `${Math.round(e.y)}-26*abs(sin(6*(t-${T0})))*exp(-1.5*(t-${T0}))`;
  if (e.kind === "hand") { // la main arrive en glissant puis « appuie »
    const A = e.arrive.toFixed(3), dur = Math.max(0.2, e.arrive - e.t0).toFixed(3);
    const p = `min(1,(t-${T0})/${dur})`;
    ex = `${Math.round(e.x)}+${e.from.dx}*(1-${p})*(1-${p})`;
    ey = `${Math.round(e.y)}+${e.from.dy}*(1-${p})*(1-${p})+if(between(t,${A},${A}+0.18),10,0)`;
  }
  if (e.kind === "bell") ex = `${Math.round(e.x)}+7*sin(28*(t-${T0}))*exp(-2.2*(t-${T0}))`;
  if (e.kind === "like") ey = `${Math.round(e.y)}-40*abs(sin(7*(t-${T0})))*exp(-3*(t-${T0}))`;
  f.push(`[${last}][e${k}]overlay=x='${ex}':y='${ey}':eof_action=pass:enable='between(t,${T0},${e.t1.toFixed(3)})'[oe${k}]`);
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
