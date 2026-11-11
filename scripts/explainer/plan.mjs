// scripts/explainer/plan.mjs — voix transcrite → plan de scènes animées (content/explainer.json)
// Entrée : content/transcript.json { lang, duration, words:[{t0,t1,w}] } (écrit par scripts/transcribe.mjs).
// 1) découpe la parole en phrases ; 2) détecte le ou les pays du Golfe → palette ; 3) l'IA (Gemini → Groq → Claude)
// choisit pour chaque passage un type de scène et écrit des textes COURTS ; 4) tout est vérifié et réparé :
//    rien n'est jamais affiché qui ne vienne de la voix (pas de chiffre ni de citation inventés), aucun emoji,
//    aucune scène trop courte pour être lue (public 50 ans et plus), aucun trou, aucun chevauchement.
// SANS IA (pas de clé, quota épuisé, réponse inutilisable) : le montage sort quand même — les phrases prononcées
// s'affichent mot pour mot en grandes cartes animées. Le workflow ne tombe jamais en panne à cause de l'IA.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { pathToFileURL } from "url";
const rel = (f) => path.relative(process.cwd(), path.resolve(f)).split(path.sep).join("/");
import { providers, parseJson } from "../lib/llm.mjs";
import { channelFor } from "../lib/channel.mjs";
import { detectTheme, sceneAccent, countryChip, countMentions, CODES, THEMES } from "../lib/gulf-themes.mjs";

const IN = process.env.EXPLAINER_TRANSCRIPT || "content/transcript.json";
const OUT = process.env.EXPLAINER_SPEC || "content/explainer.json";
const FORMAT = (process.env.EXPLAINER_FORMAT || "vertical").toLowerCase();
const QUALITY = (String(process.env.EXPLAINER_QUALITY || "1080").match(/\d+/) || ["1080"])[0];
const MIN_SCENE = 3.2, IDEAL_MAX = 7.5, HARD_MAX = 10, OUTRO = 4.5, LEAD = 0.12;
const TYPES = ["hook", "headline", "quote", "stat", "timeline", "list", "versus", "countries"];

const RTL = (l) => l === "ar";
const L = {
  outroTitle: { ar: "تابعوا التحليل كاملاً", fr: "Abonnez-vous pour la suite", en: "Subscribe for more", it: "Iscriviti per il seguito" },
  outroHl: { ar: "كاملاً", fr: "Abonnez-vous", en: "Subscribe", it: "Iscriviti" },
  button: { ar: "اشترك الآن", fr: "S'abonner", en: "Subscribe", it: "Iscriviti" },
  kicker: { ar: "تحليل", fr: "Analyse", en: "Analysis", it: "Analisi" },
  listen: { ar: "نستمع", fr: "Écoutons", en: "Listen", it: "Ascoltiamo" },
  langName: { ar: "arabe littéraire simple (فصحى مبسطة)", fr: "français", en: "English", it: "italiano" },
};
const pick = (o, l) => o[l] || o.en;

// ---------- nettoyage ----------
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
export const clean = (s, max = 200) => String(s ?? "").replace(EMOJI, "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[*_#`<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const wc = (s) => clean(s).split(" ").filter(Boolean).length;
const cutWords = (s, n) => { const w = clean(s).split(" ").filter(Boolean); return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…"; };
const digitsOf = (s) => String(s).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));

// ---------- phrases ----------
export function sentencesOf(words, maxWords = 24) {
  const softAt = Math.max(4, Math.round(maxWords * 0.6));
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push({ t0: cur[0].t0, t1: cur[cur.length - 1].t1, text: cur.map((x) => x.w).join(" ").replace(/\s+/g, " ").trim() }); cur = []; } };
  // la phrase se termine dans les 3 mots qui suivent ? alors on ne coupe pas juste avant (pas de mot orphelin)
  const nearEnd = (i) => [1, 2, 3].some((k) => words[i + k] && /[.!?؟…。]["»”)]*$/.test(words[i + k].w) && [...Array(k).keys()].every((q) => words[i + q + 1].t0 - words[i + q].t1 <= 0.7));
  for (let i = 0; i < words.length; i++) {
    const w = words[i]; cur.push(w);
    const nx = words[i + 1];
    const gap = nx ? nx.t0 - w.t1 : 9;
    const end = /[.!?؟…。]["»”)]*$/.test(w.w);
    const soft = /[,،;؛:]$/.test(w.w);
    if (end || gap > 0.7 || (cur.length >= softAt && (soft || gap > 0.3)) || (cur.length >= maxWords && !nearEnd(i)) || cur.length >= maxWords + 3) flush();
  }
  flush();
  return out.map((s, i) => ({ ...s, i }));
}
function sane(words, duration) {
  const out = []; let last = 0;
  for (const w of Array.isArray(words) ? words : []) {
    const txt = clean(w?.w ?? w?.word ?? "", 80); if (!txt) continue;
    let t0 = Number(w.t0), t1 = Number(w.t1);
    if (!isFinite(t0)) t0 = last; if (!isFinite(t1) || t1 < t0) t1 = t0 + 0.25;
    t0 = Math.max(last, Math.min(t0, duration)); t1 = Math.max(t0 + 0.02, Math.min(t1, duration + 0.5));
    out.push({ t0, t1, w: txt }); last = t0;
  }
  return out;
}

// ---------- IA ----------
function prompt(sents, lang, th, dur, first = true, nBlocks = 1) {
  const sys = `Tu es directeur artistique d'une chaîne d'analyse géopolitique sur les pays du Golfe. Tu transformes une voix off en une suite de scènes animées élégantes (style documentaire haut de gamme) pour un public de 50 ans et plus : lisible, sobre, captivant.
Réponds UNIQUEMENT par un objet JSON {"scenes":[...]}.
RÈGLES ABSOLUES
- Langue de TOUS les textes : ${pick(L.langName, lang)}. Aucun emoji, aucun symbole décoratif, aucun hashtag.
- N'invente RIEN : aucun chiffre, date, nom, citation ou source qui ne soit pas dit dans la voix. Dans le doute, type "headline".
- Chaque scène couvre des phrases consécutives : "from" et "to" (numéros de phrases, inclus). Toutes les phrases sont couvertes, dans l'ordre, sans trou ni chevauchement.
- Durée d'une scène : 4 à 7 secondes (jamais moins de 3,5 s). Regroupe les phrases courtes.
- Textes très courts : "title" 2 à 6 mots ; "kicker" 1 à 3 mots ; "sub" 3 à 8 mots au plus ; éléments de liste 1 à 4 mots.
- "highlight" : 1 ou 2 mots EXACTEMENT repris de "title" (ou de "quote"/"label"), le mot le plus fort.
- Varie les types : jamais deux fois de suite le même, sauf "headline". ${first ? `La 1re scène est TOUJOURS "hook" : la phrase qui donne envie de rester (tension, question, enjeu), pas un résumé plat.` : `Ceci est la SUITE d'une longue vidéo : pas de "hook" ; commence par une scène qui relance l'attention.`}
- Relance l'attention toutes les 2 ou 3 scènes : question, contraste, chiffre, « mais », révélation.
- "country" : code du pays dont parle la scène (${CODES.join(", ")}) ou "" si plusieurs/aucun.
TYPES et champs
- "hook" / "headline" : kicker, title, highlight, sub (facultatif)
- "quote" : SEULEMENT si la voix rapporte les paroles de quelqu'un. kicker, quote (≤ 14 mots, fidèle), highlight, who (qui parle, tel que dit dans la voix)
- "stat" : SEULEMENT si un nombre est prononcé. kicker, value (nombre), prefix/suffix (ex. "%", "$", "Md"), label (2 à 5 mots), highlight
- "timeline" : 2 à 4 dates prononcées. kicker, items:[{date,label}]
- "list" : 2 à 4 éléments cités. kicker, title, items:[{name,role}]
- "versus" : deux acteurs/idées. kicker, a, a_sub, b, b_sub, relation ("vs" opposition, "arrow" l'un mène à l'autre, "+" alliance), sub
- "countries" : quand plusieurs pays du Golfe sont cités ensemble. kicker, title, codes:[codes pays]`;
  const user = `Durée totale : ${dur.toFixed(1)} s${nBlocks > 1 ? ` (extrait : phrases ${sents[0].i} à ${sents[sents.length - 1].i} ; garde ces numéros)` : ""}. Palette détectée : ${th.code} (${th.why}).
Phrases (numéro | début→fin en secondes | texte) :
${sents.map((s) => `${s.i} | ${s.t0.toFixed(1)}→${s.t1.toFixed(1)} | ${s.text}`).join("\n")}`;
  return { sys, user };
}
/** Voix longue (1 h et plus) : le plan est demandé par blocs d'environ 110 phrases (≈ 8 à 10 min) — une seule réponse géante
 *  serait coupée. Un bloc qui échoue n'arrête rien : ses phrases s'affichent mot pour mot, les autres blocs gardent leur plan. */
export async function askLLM(sents, lang, th, dur, list = providers()) {
  if (!list.length) { console.log("  aucune clé IA : mode « phrases prononcées »"); return null; }
  const BLOCK = Number(process.env.EXPLAINER_LLM_BLOCK || 110), blocks = [];
  for (let a = 0; a < sents.length; a += BLOCK) blocks.push(sents.slice(a, a + BLOCK));
  if (blocks.length > 1 && blocks[blocks.length - 1].length < 15) blocks.splice(-2, 2, [...blocks[blocks.length - 2], ...blocks[blocks.length - 1]]);
  const deadline = Date.now() + Math.min(40 * 60, Number(process.env.EXPLAINER_LLM_BUDGET_S || 0) || 240 + blocks.length * 150) * 1000;
  const out = []; let okBlocks = 0, dead = 0;
  for (let b = 0; b < blocks.length; b++) {
    if (Date.now() > deadline - 20000 || dead >= 2) { console.log(`  bloc ${b + 1}/${blocks.length} : ${dead >= 2 ? "IA indisponible" : "budget de temps épuisé"} → phrases prononcées`); continue; }
    let got = false;
    for (const [name, fn] of list) {
      // Gemini reçoit le bloc entier (1 appel) ; les autres IA gratuites répondent plus court → le bloc leur est donné en 2 ou 3 morceaux
      const size = name === "gemini" ? blocks[b].length : 45, subs = [];
      for (let a = 0; a < blocks[b].length; a += size) subs.push(blocks[b].slice(a, a + size));
      const part = []; let fail = false;
      for (let k = 0; k < subs.length && !fail; k++) {
        const { sys, user } = prompt(subs[k], lang, th, dur, b === 0 && k === 0, blocks.length + subs.length - 1);
        try {
          const j = parseJson(await fn(sys, user, { temperature: 0.6, maxTokens: 16000, deadline: Math.min(deadline, Date.now() + 200000), timeoutMs: 150000 }));
          if (j && Array.isArray(j.scenes) && j.scenes.length) part.push(...j.scenes); else { console.log(`  ${name} : réponse inutilisable`); fail = true; }
        } catch (e) { console.log(`  ${name} : ${String(e.message).slice(0, 160)}`); fail = true; }
      }
      if (part.length) { console.log(`  plan${blocks.length > 1 ? ` bloc ${b + 1}/${blocks.length}` : ""} écrit par ${name} : ${part.length} scènes${fail ? " (partiel : le reste en phrases prononcées)" : ""}`); out.push(...part); got = true; break; }
    }
    if (b < blocks.length - 1) await new Promise((r) => setTimeout(r, Number(process.env.EXPLAINER_LLM_PAUSE_MS || 6000)));   // respecte les limites par minute des offres gratuites
    if (got) { okBlocks++; dead = 0; } else dead++;
  }
  return okBlocks ? out : null;
}

// ---------- validation d'une scène ----------
const spoken = (sents, a, b) => sents.slice(a, b + 1).map((s) => s.text).join(" ");
// mot à mettre en lumière quand personne ne l'a choisi : un nombre, sinon le mot le plus long
function autoHl(title) {
  const w = clean(title).split(" ").map((x) => x.replace(/[.,;:!?،؛؟«»"“”()…]/g, "")).filter(Boolean);
  if (w.length < 2) return "";
  return w.find((x) => /\d/.test(digitsOf(x))) || [...w].sort((a, b) => b.length - a.length)[0];
}
function fallbackData(text, lang, first) {
  const t = cutWords(text, 13).replace(/[.,،؛;:]+$/, "");
  return { type: first ? "hook" : "headline", data: { kicker: pick(L.kicker, lang), title: t, highlight: autoHl(t) } };
}
function hlOf(h, ...hay) {
  const pool = hay.join(" ").toLowerCase().split(/\s+/).map((w) => w.replace(/[.,;:!?،؛؟«»"“”()…]/g, ""));
  return clean(h, 60).split(" ").filter((w) => pool.includes(w.toLowerCase().replace(/[.,;:!?،؛؟«»"“”()…]/g, ""))).slice(0, 3).join(" ");
}
function validate(raw, text, lang, first) {
  const r = raw && typeof raw === "object" ? raw : {};
  let type = TYPES.includes(r.type) ? r.type : "headline";
  if (first) type = "hook"; else if (type === "hook") type = "headline";
  const d = { kicker: cutWords(r.kicker, 4) || pick(L.kicker, lang), context: cutWords(r.context, 5), source: cutWords(r.source, 8) };
  const txtDigits = digitsOf(text);
  const fb = () => { const f = fallbackData(r.title || r.label || r.quote || text, lang, first); return { type: f.type, data: { ...d, ...f.data, highlight: hlOf(r.highlight, f.data.title) || f.data.highlight } }; };
  try {
    if (type === "hook" || type === "headline") {
      const title = cutWords(r.title, 9); if (!title) return fb();
      return { type, data: { ...d, title, highlight: hlOf(r.highlight, title) || autoHl(title), sub: cutWords(r.sub, 11) } };
    }
    if (type === "quote") {
      const quote = cutWords(String(r.quote || "").replace(/^["“«”]+|["”»“]+$/g, ""), 18); if (wc(quote) < 2) return fb();
      return { type, data: { ...d, quote, highlight: hlOf(r.highlight, quote), who: cutWords(r.who, 6), paper: true } };
    }
    if (type === "stat") {
      const value = Number(String(digitsOf(r.value)).replace(/[^\d.,-]/g, "").replace(",", "."));
      const label = cutWords(r.label, 7);
      // le nombre doit avoir été prononcé (présent en chiffres dans la transcription) — sinon pas de chiffre à l'écran
      const intPart = String(Math.trunc(Math.abs(value)));
      if (!isFinite(value) || !label || !txtDigits.replace(/[\s.,٬٫]/g, "").includes(intPart)) return fb();
      const dec = Number.isInteger(value) ? 0 : Math.min(2, (String(value).split(".")[1] || "").length);
      return { type, data: { ...d, value, decimals: dec, prefix: clean(r.prefix, 4), suffix: clean(r.suffix, 6), label, highlight: hlOf(r.highlight, label), fill: 0.62 + (Math.abs(value) % 7) * 0.05 } };
    }
    if (type === "timeline") {
      const items = (Array.isArray(r.items) ? r.items : []).map((x) => ({ date: cutWords(x?.date, 3), label: cutWords(x?.label, 6) }))
        .filter((x) => x.date && x.label && (!/\d/.test(digitsOf(x.date)) || txtDigits.includes(digitsOf(x.date).match(/\d+/)[0]))).slice(0, 4);
      if (items.length < 2) return fb();
      return { type, data: { ...d, items } };
    }
    if (type === "list") {
      const items = (Array.isArray(r.items) ? r.items : []).map((x) => (typeof x === "string" ? { name: cutWords(x, 5) } : { name: cutWords(x?.name, 5), role: cutWords(x?.role, 7) })).filter((x) => x.name).slice(0, 4);
      if (items.length < 2) return fb();
      const title = cutWords(r.title, 7);
      return { type, data: { ...d, title, highlight: hlOf(r.highlight, title), items } };
    }
    if (type === "versus") {
      const a = cutWords(r.a, 4), b = cutWords(r.b, 4); if (!a || !b) return fb();
      return { type, data: { ...d, a, b, a_sub: cutWords(r.a_sub, 5), b_sub: cutWords(r.b_sub, 5), relation: ["vs", "+", "arrow"].includes(r.relation) ? r.relation : "arrow", sub: cutWords(r.sub, 10) } };
    }
    if (type === "countries") {
      const said = Object.keys(countMentions(text));
      const codes = [...new Set((Array.isArray(r.codes) ? r.codes : []).map((c) => String(c).toLowerCase()).filter((c) => CODES.includes(c) && said.includes(c)))];
      const title = cutWords(r.title, 7);
      if (codes.length < 2 || !title) return fb();
      return { type, data: { ...d, title, highlight: hlOf(r.highlight, title), items: codes.slice(0, 6).map((c) => countryChip(c, lang)) } };
    }
  } catch { /* scène mal formée → repli */ }
  return fb();
}

// ---------- assemblage ----------
/** Regroupe les phrases en blocs lisibles quand l'IA n'a rien donné (ou pour boucher un trou). */
function chunk(sents, a, b) {
  const out = []; let s = a;
  while (s <= b) {
    let e = s;
    while (e < b && sents[e + 1].t0 - sents[s].t0 < MIN_SCENE) e++;
    out.push({ from: s, to: e }); s = e + 1;
  }
  if (out.length > 1) { const l = out[out.length - 1]; if (sents[l.to].t1 - sents[l.from].t0 < MIN_SCENE) { out.pop(); out[out.length - 1].to = l.to; } }
  return out;
}
export function build(sents, rawScenes, lang, duration) {
  const n = sents.length; let ranges = [];
  // 1) plages de l'IA remises en ordre, bornées, sans chevauchement ; trous comblés par des scènes « phrase prononcée »
  let next = 0;
  for (const r of (rawScenes || []).filter((x) => x && typeof x === "object").map((x) => ({ r: x, from: Math.round(Number(x.from)), to: Math.round(Number(x.to ?? x.from)) }))
    .filter((x) => isFinite(x.from) && isFinite(x.to)).sort((p, q) => p.from - q.from)) {
    let from = Math.max(next, Math.min(r.from, n - 1)), to = Math.max(from, Math.min(r.to, n - 1));
    if (r.to < next || next >= n) continue;                      // entièrement déjà couvert
    if (from > next) ranges.push(...chunk(sents, next, from - 1));
    ranges.push({ from, to, r: r.r }); next = to + 1;
  }
  if (next < n) ranges.push(...chunk(sents, next, n - 1));
  // 2) scènes trop courtes : fusion avec la voisine (on garde le texte de la plus longue)
  const len = (x) => sents[x.to].t1 - sents[x.from].t0;
  for (let i = 0; i < ranges.length && ranges.length > 1;) {
    const start = i === 0 ? 0 : sents[ranges[i].from].t0 - LEAD, end = i === ranges.length - 1 ? duration : sents[ranges[i + 1].from].t0 - LEAD;
    if (end - start >= MIN_SCENE) { i++; continue; }
    const j = i === ranges.length - 1 ? i - 1 : i + 1, [p, q] = i < j ? [i, j] : [j, i];
    const keep = len(ranges[p]) >= len(ranges[q]) ? ranges[p] : ranges[q];
    ranges.splice(p, 2, { from: ranges[p].from, to: ranges[q].to, r: (p === 0 ? ranges[p].r : keep.r) || ranges[p].r || ranges[q].r });
    i = Math.max(0, p - 1);
  }
  // 3) scènes trop longues : coupées à la frontière de phrase la plus proche du milieu
  for (let i = 0; i < ranges.length; i++) {
    const x = ranges[i], start = i === 0 ? 0 : sents[x.from].t0, end = i === ranges.length - 1 ? duration : sents[ranges[i + 1].from].t0;
    if (end - start <= HARD_MAX || x.to === x.from) continue;
    let best = -1, bd = 1e9; const mid = (start + end) / 2;
    for (let k = x.from; k < x.to; k++) { const t = sents[k + 1].t0 - LEAD; if (t - start >= MIN_SCENE && end - t >= MIN_SCENE && Math.abs(t - mid) < bd) { bd = Math.abs(t - mid); best = k; } }
    if (best < 0) continue;
    ranges.splice(i, 1, { from: x.from, to: best, r: x.r }, { from: best + 1, to: x.to }); i--;
  }
  // 4) scènes finales, horodatées sur la voix
  const scenes = []; let prevType = "";
  ranges.forEach((x, i) => {
    const text = spoken(sents, x.from, x.to);
    let v = x.r ? validate(x.r, text, lang, i === 0) : (() => { const f = fallbackData(text, lang, i === 0); return { type: f.type, data: f.data }; })();
    if (v.type === prevType && !["headline", "hook"].includes(v.type)) { const f = fallbackData(x.r?.title || x.r?.label || text, lang, false); v = { type: "headline", data: { ...v.data, ...f.data } }; }
    prevType = v.type;
    const t0 = i === 0 ? 0 : Math.max(0, sents[x.from].t0 - LEAD);
    const code = String(x.r?.country || "").toLowerCase();
    const said = Object.keys(countMentions(text));
    scenes.push({ type: v.type, data: v.data, t0, from: x.from, to: x.to, ...(CODES.includes(code) && said.includes(code) ? { country: code } : said.length === 1 ? { country: said[0] } : {}) });
  });
  scenes.forEach((s, i) => { s.t1 = i === scenes.length - 1 ? duration : scenes[i + 1].t0; });
  return scenes;
}

// ---------- médias fournis : captures d'écran, photos, vidéos ----------
const probe = (f) => { try { const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { maxBuffer: 1 << 24 }).toString());
  const v = j.streams.find((s) => s.codec_type === "video"); if (!v) return null; let w = v.width, h = v.height;
  const rot = Math.abs(Number((v.side_data_list || []).find((x) => x.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180; if (rot === 90) [w, h] = [h, w];
  return w > 0 && h > 0 ? { w, h, dur: Number(j.format.duration) || 0, audio: j.streams.some((s) => s.codec_type === "audio") } : null; } catch { return null; } };
function listMedia() {
  const ls = (dirs, re) => { for (const d of dirs) if (existsSync(d)) { const f = readdirSync(d).filter((x) => re.test(x)).sort().map((x) => path.resolve(d, x)); if (f.length) return f; } return []; };
  const imgs = ls(["input/photos", "content/photos"], /\.(jpe?g|png|webp)$/i).map((file) => ({ kind: "img", file, p: probe(file) })).filter((x) => x.p);
  const vids = ls(["input/clips", "content/clips-src"], /\.(mp4|mov|mkv|webm|m4v|avi)$/i).map((file) => ({ kind: "vid", file, p: probe(file) })).filter((x) => x.p && x.p.dur >= 0.5);
  return { imgs, vids };
}
/** Images d'une vidéo extraites en JPEG (le gabarit affiche l'image exacte de chaque instant : synchro parfaite). */
function extractFrames(v, idx, maxDur, side) {
  const dir = path.resolve("content/clips", String(idx).padStart(2, "0")); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const dur = Math.min(v.p.dur, maxDur);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", v.file, "-t", dur.toFixed(3), "-an", "-vf", `fps=30,scale='if(gte(iw,ih),min(${side},iw),-2)':'if(gte(iw,ih),-2,min(${side},ih))'`, "-q:v", "4", path.join(dir, "%05d.jpg")], { stdio: ["ignore", "ignore", "inherit"] });
  const n = readdirSync(dir).filter((x) => x.endsWith(".jpg")).length;
  if (!n) throw new Error("aucune image extraite");
  return { dir: rel(dir), n, fps: 30, dur: n / 30 };
}
const thumb = (file, at = 0) => execFileSync("ffmpeg", ["-v", "error", ...(at ? ["-ss", at.toFixed(2)] : []), "-i", file, "-vf", "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease", "-frames:v", "1", "-q:v", "7", "-f", "mjpeg", "-"], { maxBuffer: 1 << 24 });

// Mots déclencheurs : « écoutez », « خلينا نسمع »… → la vidéo suivante est jouée AVEC SON SON, la voix attend puis reprend.
const TRIGGERS = [/(?:^| )[وف]?(?:خلينا|خلونا|دعونا|لنستمع|لنسمع) ?(?:نسمع|نستمع)?(?= |$)/u, /(?:^| )[وف]?(?:اسمع|اسمعوا|استمع|استمعوا)(?: (?:جيدا|معي))?(?= |$)/u,
  /(?:^| )(?:écoutez|écoute|écoutons|ecoutez|ecoute|ecoutons)(?= |$)/u, /(?:^| )(?:listen|let s listen|lets listen)(?= |$)/u, /(?:^| )(?:ascolta|ascoltate|ascoltiamo|sentite|sentiamo)(?= |$)/u];
const normTrig = (s) => " " + String(s).toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
export const triggerSentences = (sents) => sents.filter((s) => TRIGGERS.some((re) => re.test(normTrig(s.text)))).map((s) => s.i);

/** UN SEUL appel Gemini pour tous les médias (miniatures) : phrase illustrée, zone utile (recadrage), légende. Sert aux deux
 *  formats. Sans Gemini ou en cas d'échec : médias posés dans l'ordre, répartis sur la durée, sans recadrage intelligent. */
async function analyseMedia(items, sents, lang) {
  for (const x of items) { x.sentence = null; x.crop = null; x.caption = ""; x.photo = false; }
  const gem = providers().find(([n]) => n === "gemini");
  if (!items.length) return;
  if (!gem || process.env.EXPLAINER_NO_LLM === "1") { console.log("  médias : pas de clé Gemini → pose dans l'ordre, sans recadrage intelligent"); return; }
  try {
    const sub = items.slice(0, 30), parts = [];
    sub.forEach((x, i) => { try { parts.push({ text: `Média ${i} (${x.kind === "vid" ? "vidéo, image extraite" : "image"}) :` }, { inlineData: { mimeType: "image/jpeg", data: thumb(x.file, x.kind === "vid" ? Math.min(x.p.dur / 2, 3) : 0).toString("base64") } }); } catch { /* miniature impossible : ce média sera posé dans l'ordre */ } });
    const sys = `Tu es monteur. On te donne des captures d'écran, photos et vidéos (une image extraite) et la voix off découpée en phrases numérotées. Réponds UNIQUEMENT en JSON : {"medias":[{"media":n,"sentence":n,"box":[ymin,xmin,ymax,xmax],"caption":"...","photo":true|false}]}.
- "sentence" : numéro de la phrase où ce média illustre le mieux ce qui est DIT (titre d'article, nom, chiffre, lieu, personne citée). Chaque média DOIT recevoir une phrase : s'il n'y a pas de lien évident, choisis la phrase la plus proche par le thème. Évite de mettre plusieurs médias sur la même phrase.
- "box" : zone utile en millièmes (0 à 1000). Capture d'écran : retire barre d'état du téléphone, barre de navigation, menus, boutons, publicités, marges vides ; garde titre, texte clé, illustration. Photo ou vidéo : [0,0,1000,1000].
- "caption" : 2 à 6 mots en ${pick(L.langName, lang)} disant ce que montre le média (source ou sujet VISIBLE). N'invente rien. Aucun emoji.
- "photo" : true si c'est une photographie sans texte important, false pour capture d'écran, article, document, publication.`;
    const j = parseJson(await gem[1](sys, `Phrases :\n${sents.map((s) => `${s.i} | ${s.text}`).join("\n")}`, { parts, temperature: 0.2, maxTokens: 6000, deadline: Date.now() + 170000, timeoutMs: 140000 }));
    for (const r of Array.isArray(j?.medias) ? j.medias : []) {
      const x = sub[Math.round(Number(r?.media))]; if (!x) continue;
      const sn = Math.round(Number(r.sentence)); if (isFinite(sn) && sn >= 0 && sn < sents.length) x.sentence = sn;
      const b = (Array.isArray(r.box) ? r.box : []).map(Number);
      if (x.kind === "img" && b.length === 4 && b.every((v) => isFinite(v))) {
        const [y0, x0, y1, x1] = b.map((v) => Math.max(0, Math.min(1000, v)) / 1000);
        // recadrage accepté seulement s'il est plausible (ni minuscule ni inversé, ni « tout ») — sinon image entière
        if (y1 - y0 >= 0.25 && x1 - x0 >= 0.4 && (y1 - y0 < 0.985 || x1 - x0 < 0.985)) x.crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      x.caption = cutWords(r.caption, 7); x.photo = r.photo === true;
    }
    console.log(`  médias analysés par Gemini : ${items.filter((x) => x.sentence !== null).length}/${items.length} reliés à une phrase, ${items.filter((x) => x.crop).length} recadrés`);
  } catch (e) { console.log(`  analyse des médias impossible (${String(e.message).slice(0, 120)}) : pose dans l'ordre`); }
}
const mediaData = (x) => (x.kind === "vid" ? { kind: "vid", ...x.frames, iw: x.p.w, ih: x.p.h } : { kind: "img", image: rel(x.file), iw: x.p.w, ih: x.p.h, crop: x.crop });
/** Pose TOUS les médias (aucun n'est jamais écarté) : d'abord sur la scène de leur phrase, sinon répartis sur les scènes
 *  libres ; s'il y a plus de médias que de scènes, plusieurs médias se partagent une scène (ils s'enchaînent en fondu). */
export function placeMedia(scenes, items) {
  if (!items.length || !scenes.length) return 0;
  const body = scenes.map((_, i) => i).filter((i) => scenes[i].type !== "outro");
  const pool = body.length > 1 ? body.slice(1) : body;                       // l'accroche est épargnée tant que c'est possible
  const load = new Map(pool.map((i) => [i, []]));
  const cap = (i) => Math.max(1, Math.floor((scenes[i].t1 - scenes[i].t0) / 2.4));   // ≥ 2,4 s par média tant que possible
  const rest = [];
  for (const x of items) {
    if (x.sentence === null) { rest.push(x); continue; }
    const i = scenes.findIndex((s) => s.from <= x.sentence && x.sentence <= s.to);
    const c = [i, i + 1, i - 1, i + 2, i - 2].find((k) => load.has(k) && load.get(k).length === 0) ?? [i, i + 1, i - 1].find((k) => load.has(k) && load.get(k).length < cap(k));
    if (c === undefined) rest.push(x); else load.get(c).push(x);
  }
  // le reste : scènes vides réparties régulièrement, puis scènes ayant encore de la place, puis la moins chargée (garantie)
  const empty = pool.filter((i) => load.get(i).length === 0);
  rest.forEach((x, k) => {
    let i;
    if (k < empty.length) i = empty[Math.min(empty.length - 1, Math.floor(((k + 0.5) * empty.length) / Math.min(rest.length, empty.length)))];
    if (i === undefined || load.get(i).length) i = pool.find((p) => load.get(p).length === 0) ?? pool.filter((p) => load.get(p).length < cap(p)).sort((a, b) => load.get(a).length - load.get(b).length)[0]
      ?? [...pool].sort((a, b) => load.get(a).length / (scenes[a].t1 - scenes[a].t0) - load.get(b).length / (scenes[b].t1 - scenes[b].t0))[0];
    load.get(i).push(x);
  });
  let used = 0;
  for (const [i, list] of load) {
    if (!list.length) continue;
    const s = scenes[i], d = s.data, first = list[0];
    const title = d.title || d.label || d.quote || [d.a, d.b].filter(Boolean).join(" · ") || first.caption;
    if (list.length === 1 && first.kind === "img" && first.photo && !first.crop) { s.type = "photo"; s.data = { kicker: d.kicker, context: d.context, source: first.caption || d.source, title: cutWords(title, 11), highlight: d.highlight, photo: rel(first.file) }; }
    else { s.type = "shot"; s.data = { kicker: d.kicker, context: d.context, source: first.caption || d.source, title: cutWords(title, 11), highlight: d.highlight, media: list.map(mediaData) }; }
    used += list.length;
  }
  return used;
}
/** Insère les vidéos « à écouter » : la scène en cours est coupée à l'instant voulu, la vidéo joue (avec son son), puis la
 *  scène reprend là où elle en était. Tous les horaires qui suivent sont décalés. Renvoie le plan audio. */
export function insertClips(scenes, inserts, lang) {
  const cuts = []; let shift = 0;
  for (const ins of [...inserts].sort((a, b) => a.vt - b.vt)) {
    let at = ins.vt + shift;
    let i = scenes.findIndex((s) => s.t0 <= at && at < s.t1); if (i < 0) i = scenes.length - 1;
    const s = scenes[i];
    if (s.t1 - at < 1.0) at = s.t1; else if (at - s.t0 < 1.0) at = s.t0;          // trop près d'un bord : on se cale dessus
    const clip = { type: "shot", t0: at, t1: at + ins.dur, big: true, transition: "zoom", data: { kicker: pick(L.listen, lang), media: [ins.media] } };
    let idx;
    if (at === s.t1) idx = i + 1; else if (at === s.t0) idx = i;
    else { const span = s.span || s.t1 - s.t0, off = s.offset || 0; scenes.splice(i, 1, { ...s, t1: at, span }, { ...s, t0: at, offset: off + (at - s.t0), span, transition: "cut" }); idx = i + 1; }
    scenes.splice(idx, 0, clip);
    for (let k = idx + 1; k < scenes.length; k++) { scenes[k].t0 += ins.dur; scenes[k].t1 += ins.dur; }
    cuts.push({ voiceAt: at - shift, at, dur: ins.dur, file: ins.file, audio: ins.audio });
    shift += ins.dur;
  }
  return { cuts, shift };
}
const hasAlpha = (f) => { try { return /a|pal8/.test(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", f]).toString().trim().replace(/^gray$|^rgb24$|^yuv.*$/, "")); } catch { return false; } };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 100000 + 1; };

async function main() {
  if (!existsSync(IN)) throw new Error(`${IN} introuvable : la transcription n'a pas tourné.`);
  const tr = JSON.parse(readFileSync(IN, "utf8"));
  const duration = Number(tr.duration);
  if (!isFinite(duration) || duration < 2) throw new Error("fichier voix trop court ou illisible (moins de 2 s).");
  const lang = ["ar", "fr", "en", "it"].includes(String(tr.lang).slice(0, 2)) ? String(tr.lang).slice(0, 2) : "fr";
  const words = sane(tr.words, duration);
  if (!words.length) throw new Error("aucune parole détectée dans le fichier voix.");
  let sents = sentencesOf(words);
  const full = sents.map((s) => s.text).join(" ");
  const th = detectTheme(full, process.env.EXPLAINER_PAYS === "auto" ? "" : process.env.EXPLAINER_PAYS);
  console.log(`Voix : ${duration.toFixed(1)} s, langue ${lang}, ${sents.length} phrases. Palette : ${th.why}`);

  const raw = process.env.EXPLAINER_NO_LLM === "1" ? null : await askLLM(sents, lang, th, duration);
  if (!raw) sents = sentencesOf(words, 9);          // sans IA : phrases courtes, affichées mot pour mot
  let scenes = build(sents, raw, lang, duration);
  for (const s of scenes) if (s.country && s.country !== th.code) s.accent = sceneAccent(s.country);
  const base = Number(QUALITY) >= 2160 ? 2160 : Number(QUALITY) >= 1440 ? 1440 : 1080;

  // --- médias fournis : captures / photos / vidéos. TOUS sont insérés.
  const { imgs, vids } = listMedia(); const notes = [];
  const side = base >= 2160 ? 1440 : 960, CLIP_MAX = Number(process.env.EXPLAINER_CLIP_MAX_S || 90);
  // 1) mots déclencheurs (« écoutez », « خلينا نسمع »…) → vidéos jouées avec leur son, dans l'ordre des noms de fichiers
  const trig = process.env.EXPLAINER_TRIGGERS === "non" ? [] : triggerSentences(sents);
  const inserts = [], broll = [];
  vids.forEach((v, k) => {
    const heard = k < trig.length;
    try { v.frames = extractFrames(v, k + 1, heard ? CLIP_MAX : 20, side); } catch (e) { notes.push(`⚠ vidéo illisible ignorée : ${path.basename(v.file)}`); return; }
    if (heard) { const sn = sents[trig[k]], nx = sents[trig[k] + 1]; inserts.push({ vt: nx ? (sn.t1 + nx.t0) / 2 : duration, dur: v.frames.dur, media: mediaData(v), file: rel(v.file), audio: v.p.audio });
      if (v.p.dur > CLIP_MAX + 0.5) notes.push(`⚠ ${path.basename(v.file)} : ${v.p.dur.toFixed(0)} s, joué ${CLIP_MAX} s (coupe la vidéo avant de la déposer pour choisir le passage)`); }
    else broll.push(v);
  });
  if (trig.length > vids.length && vids.length) notes.push(`${trig.length} mots déclencheurs entendus pour ${vids.length} vidéo(s) : les ${trig.length - vids.length} derniers n'ont pas de vidéo`);
  // 2) captures, photos et vidéos restantes : reliées à ce qui est dit (un seul appel IA), recadrées, posées — aucune n'est écartée
  const items = [...imgs, ...broll];
  await analyseMedia(items, sents, lang);
  const placed = placeMedia(scenes, items);
  // 3) insertion des vidéos à écouter (la voix attend, puis reprend)
  const { cuts, shift } = insertClips(scenes, inserts, lang);
  const total0 = duration + shift;

  const ch = process.env.EXPLAINER_LOGO === "non" ? { nom: "", logo: null, why: "logo désactivé" } : channelFor(lang);
  const withOutro = process.env.EXPLAINER_OUTRO !== "non";
  let total = total0;
  if (withOutro) { scenes.push({ type: "outro", t0: total0, t1: total0 + OUTRO, data: { title: pick(L.outroTitle, lang), highlight: pick(L.outroHl, lang), sub: clean(ch.nom, 40), button: pick(L.button, lang) } }); total += OUTRO; }

  const long = Math.round((base * 16) / 9 / 2) * 2;
  // un seul plan (une seule série d'appels IA) pour tous les formats demandés
  const formats = /deux|both|2/.test(FORMAT) ? ["vertical", "horizontal"] : [FORMAT.startsWith("h") ? "horizontal" : "vertical"];
  const [w, h] = formats[0] === "horizontal" ? [long, base] : [base, long];
  // transitions fixées ici (jamais deux fois la même de suite) : le rendu par tranches donne exactement la même vidéo
  { const TR = ["glare", "zoom", "iris", "push", "blinds", "glare", "zoom", "blinds"]; let sd = hash(full) * 31 + 5, last = "";
    const rnd = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };
    scenes.forEach((s, i) => { if (!s.transition) { if (i === 0) s.transition = "open"; else { let t; do { t = TR[Math.floor(rnd() * TR.length)]; } while (t === last); s.transition = t; } } last = s.transition; }); }
  // logo copié à côté du plan (le dossier des chaînes n'existe pas sur les machines de rendu)
  let logo = null;
  if (ch.logo) { try { logo = `content/logo${path.extname(ch.logo).toLowerCase() || ".png"}`; mkdirSync("content", { recursive: true }); copyFileSync(ch.logo, logo); } catch { logo = null; } }
  // poids : chaque fichier reste sous la limite des releases (2 Go) quelle que soit la durée
  const scale = (base * long) / (1080 * 1920), maxrateK = Math.max(900, Math.min(Math.round(10000 * scale), Math.floor((1.75e9 * 8) / total / 1000) - 200));
  if (maxrateK < 5000 * scale) notes.push(`vidéo longue : débit plafonné à ${(maxrateK / 1000).toFixed(1)} Mb/s pour rester sous 2 Go par fichier${base > 1080 ? " — en 1080 l'image sera plus nette à ce débit" : ""}`);
  const spec = { w, h, fps: 30, maxrateK, grain: total <= 20 * 60, duration: Math.round(total * 30) / 30, voice: duration, voiceEnd: total0, cuts, lang, dir: RTL(lang) ? "rtl" : "ltr", seed: hash(full), themeCode: th.code, theme: th.theme,
    logo, logoAlpha: logo ? hasAlpha(logo) : false, channel: ch.nom || "", crf: base >= 2160 ? 21 : 19, scenes };
  mkdirSync(path.dirname(OUT), { recursive: true });
  for (const f of ["vertical", "horizontal"]) { const p = OUT.replace(/\.json$/, `-${f}.json`); if (existsSync(p)) rmSync(p); }
  for (const f of formats) writeFileSync(OUT.replace(/\.json$/, `-${f}.json`), JSON.stringify({ ...spec, format: f, w: f === "horizontal" ? long : base, h: f === "horizontal" ? base : long }, null, 1));
  writeFileSync(OUT, JSON.stringify(spec, null, 1));
  const N = Math.round(spec.duration * 30), PART = Number(process.env.EXPLAINER_PART_S || 240) * 30, nParts = Math.max(1, Math.ceil(N / PART)), matrix = [];
  for (const f of formats) for (let k = 0; k < nParts; k++) matrix.push({ format: f, part: String(k + 1).padStart(3, "0"), f0: Math.floor((N * k) / nParts), f1: Math.floor((N * (k + 1)) / nParts) });
  writeFileSync("content/matrix.json", JSON.stringify(matrix));
  const md = [`# Faceless live arabic — plan`, ``, `- Durée voix : ${duration.toFixed(1)} s · langue : ${lang} · format : ${formats.join(" + ")} (${base}p)`, `- Palette : **${th.code}** — ${th.why}`, `- Chaîne / logo : ${ch.why || "—"}`,
    `- Écriture : ${raw ? "IA" : "sans IA (phrases prononcées affichées telles quelles)"} `,
    `- Médias : ${imgs.length} capture(s)/photo(s) + ${broll.length} vidéo(s) d'illustration → **${placed}/${items.length} insérés**${imgs.some((x) => x.crop) ? ` (${imgs.filter((x) => x.crop).length} recadrés par l'IA)` : ""} · ${cuts.length} vidéo(s) à écouter insérée(s) sur mot déclencheur`, ...notes.map((n) => `- ${n}`), ``, `| # | début | durée | type | pays | texte |`, `|---|---|---|---|---|---|`,
    ...scenes.map((s, i) => `| ${i + 1} | ${s.t0.toFixed(1)} s | ${(s.t1 - s.t0).toFixed(1)} s | ${s.type}${s.data.media ? ` ×${s.data.media.length}` : ""}${s.offset ? " (suite)" : ""} | ${s.country || ""} | ${(s.big ? `▶ vidéo à écouter (${path.basename(cuts.find((c) => Math.abs(c.at - s.t0) < 0.01)?.file || "")})` : s.data.title || s.data.quote || s.data.label || [s.data.a, s.data.b].filter(Boolean).join(" / ") || (s.data.items || []).map((x) => x.date || x.name).join(" · ")).replace(/\|/g, "/")} |`)].join("\n");
  mkdirSync("output", { recursive: true }); writeFileSync("output/EXPLAINER.md", md + "\n");
  console.log(`✔ ${OUT} : ${scenes.length} scènes (${scenes.map((s) => s.type).join(", ")})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error("❌ " + e.message); process.exit(1); });
