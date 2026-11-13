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
import { prepClip } from "./clipprep.mjs";
import { channelFor } from "../lib/channel.mjs";
import { detectTheme, sceneAccent, countryChip, countMentions, CODES, THEMES, COUNTRIES } from "../lib/gulf-themes.mjs";
import { transcribeStart } from "../lib/asr.mjs";

const IN = process.env.EXPLAINER_TRANSCRIPT || "content/transcript.json";
const OUT = process.env.EXPLAINER_SPEC || "content/explainer.json";
const FORMAT = (process.env.EXPLAINER_FORMAT || "vertical").toLowerCase();
const QUALITY = (String(process.env.EXPLAINER_QUALITY || "1080").match(/\d+/) || ["1080"])[0];
const MIN_SCENE = 3.2, IDEAL_MAX = 7.5, HARD_MAX = 10, OUTRO = 6, OUTRO_H = 8, LEAD = 0.12;   // écran de fin : 6 s en vertical, 8 s en horizontal
const TYPES = ["hook", "headline", "quote", "stat", "timeline", "list", "versus", "countries"];

const RTL = (l) => l === "ar";
const L = {
  outroTitle: { ar: "تابعوا التحليل كاملاً", fr: "Abonnez-vous pour la suite", en: "Subscribe for more", it: "Iscriviti per il seguito" },
  outroHl: { ar: "كاملاً", fr: "Abonnez-vous", en: "Subscribe", it: "Iscriviti" },
  button: { ar: "للاشتراك\nو جديد القناة", fr: "S'abonner", en: "Subscribe", it: "Iscriviti" },
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
// ---------- fiche YouTube (titre, description, tags, hashtags) ----------
const YT_SHAPE = `{"title":"...","description":"...","tags":["..."],"hashtags":["#..."]}`;
const ytRules = (lang) => `RÈGLES DE LA FICHE YOUTUBE (langue : ${pick(L.langName, lang)})
- "title" : 45 à 70 caractères, provocateur et original : il crée une tension ou une question à laquelle on veut la réponse, avec le nom ou le pays clé dans les premiers mots. Fidèle à ce qui est DIT : aucune promesse que la vidéo ne tient pas, aucun fait inventé. Pas d'emoji, pas de MAJUSCULES en bloc, pas de guillemets.
- "description" : 120 à 200 mots. Les deux premières phrases reprennent les mots-clés principaux (elles s'affichent dans la recherche). Puis 3 à 5 points clés de la vidéo, un par ligne commençant par « - ». Puis une phrase qui invite à s'abonner et à commenter. Aucun emoji, aucun lien, aucun hashtag ni liste de mots-clés dans ce champ.
- "tags" : 15 à 20 mots-clés de recherche (1 à 4 mots chacun) : sujets, pays, villes, personnes et organisations CITÉS, plus leurs écritures en anglais quand la voix est en arabe. Sans # et sans virgule à l'intérieur.
- "hashtags" : 5 à 8 hashtags sans espace, du plus précis au plus général.`;
const cleanMulti = (s, max) => String(s ?? "").replace(EMOJI, "").replace(/<[^>\n]{0,40}>/g, "").replace(/[<>`]/g, "").replace(/\r/g, "").split("\n").map((l) => l.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const cutChars = (s, n) => { const t = clean(s, 400).replace(/["«»“”]/g, "").trim(); if (t.length <= n) return t; const c = t.slice(0, n + 1); return c.slice(0, Math.max(c.lastIndexOf(" "), Math.floor(n * 0.6))).replace(/[\s,،;:.\-–]+$/, "") + "…"; };
/** Fiche finale, toujours valide pour YouTube (titre ≤ 100 caractères, description ≤ 5000) — avec ou sans IA. */
export function youtubeMeta(raw, { sents, scenes, lang, countries, channel }) {
  let r = raw && typeof raw === "object" ? raw : {};
  // une fiche écrite dans une autre langue que la voix est refusée en bloc (titre arabe attendu pour une voix arabe, et inversement)
  const arab = (t) => (String(t).match(/[\u0600-\u06FF]/g) || []).length / Math.max(1, (String(t).match(/\p{L}/gu) || []).length);
  if (typeof r.title === "string" && r.title.trim() && ((lang === "ar" && arab(r.title) < 0.4) || (lang !== "ar" && arab(r.title) > 0.4))) r = {};
  const hook = scenes.find((x) => x.type === "hook")?.data?.title || sents[0]?.text || "";
  const title = cutChars(r.title, 95) || cutChars(hook, 95) || channel || "Gulf think-tank";
  let body = cleanMulti(r.description, 3200);
  if (body.length < 60) {            // sans IA : les premières phrases prononcées + les titres des scènes
    const pts = [...new Set(scenes.filter((x) => !["hook", "outro"].includes(x.type) && !x.big).map((x) => clean(x.data.title || x.data.label || "", 90)).filter(Boolean))].slice(0, 5);
    body = [sents.slice(0, 3).map((x) => x.text).join(" ").slice(0, 600), pts.length ? pts.map((x) => `- ${x}`).join("\n") : ""].filter(Boolean).join("\n\n");
  }
  const names = countries.flatMap((c) => [COUNTRIES[c].name[lang] || COUNTRIES[c].name.en, COUNTRIES[c].name.en]);
  const baseTags = [...names, ...(countries.length ? [lang === "ar" ? "الخليج العربي" : "Golfe", "GCC", "Gulf"] : []), channel].filter(Boolean);
  const tags = [...new Set([...(Array.isArray(r.tags) ? r.tags : []).map((x) => clean(x, 40).replace(/[#,،]/g, " ").replace(/\s+/g, " ").trim()), ...baseTags].filter((x) => x && x.length >= 2))].slice(0, 22);
  const tagify = (x) => "#" + clean(x, 40).replace(/^#+/, "").replace(/[^\p{L}\p{N}_ ]/gu, "").trim().replace(/\s+/g, "_");
  const hashtags = [...new Set([...(Array.isArray(r.hashtags) ? r.hashtags : []), ...names.slice(0, 4), channel.replace(/[- ]+/g, "")].filter(Boolean).map(tagify).filter((x) => x.length >= 3 && x.length <= 40))]
    .filter((x, i, a) => a.findIndex((y) => y.toLowerCase().replace(/_/g, "") === x.toLowerCase().replace(/_/g, "")) === i).slice(0, 8);
  const description = [body, tags.join(", "), hashtags.join(" ")].filter(Boolean).join("\n\n").slice(0, 4800);
  return { title, description, tags, hashtags, ai: !!(r.title && r.description) };
}
/** Voix longue (plusieurs blocs) ou fiche absente de la réponse : UN petit appel à part, sur les titres des scènes. */
async function askYoutube(sents, scenes, lang, list = providers()) {
  if (!list.length || process.env.EXPLAINER_NO_LLM === "1") return null;
  const titles = scenes.filter((x) => !["outro"].includes(x.type) && !x.big).map((x) => clean(x.data.title || x.data.quote || x.data.label || [x.data.a, x.data.b].filter(Boolean).join(" / "), 90)).filter(Boolean);
  const step = Math.max(1, Math.ceil(titles.length / 140));
  const user = `Début de la voix off :\n${sents.slice(0, 14).map((x) => x.text).join(" ").slice(0, 1800)}\n\nFil de la vidéo (titres des scènes, dans l'ordre) :\n${titles.filter((_, i) => i % step === 0).map((x) => `- ${x}`).join("\n")}\n\nFin de la voix off :\n${sents.slice(-5).map((x) => x.text).join(" ").slice(0, 700)}`;
  const sys = `Tu es le rédacteur YouTube d'une chaîne d'analyse géopolitique. Réponds UNIQUEMENT par un objet JSON ${YT_SHAPE}.\n${ytRules(lang)}`;
  for (const [name, fn] of list) {
    try { const j = parseJson(await fn(sys, user, { temperature: 0.8, maxTokens: 3000, deadline: Date.now() + 120000, timeoutMs: 100000 })); if (j && j.title && j.description) { console.log(`  fiche YouTube écrite par ${name}`); return j; } }
    catch (e) { console.log(`  fiche YouTube — ${name} : ${String(e.message).slice(0, 120)}`); }
  }
  return null;
}

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
  const yt = nBlocks === 1 ? `\nAJOUTE dans le même objet JSON la fiche YouTube : "youtube":${YT_SHAPE}\n${ytRules(lang)}` : "";
  const user = `${yt ? yt + "\n\n" : ""}Durée totale : ${dur.toFixed(1)} s${nBlocks > 1 ? ` (extrait : phrases ${sents[0].i} à ${sents[sents.length - 1].i} ; garde ces numéros)` : ""}. Palette détectée : ${th.code} (${th.why}).
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
        // la fiche YouTube est demandée avec le plan seulement quand toute la voix tient dans cet appel
        try {
          const j = parseJson(await fn(sys, user, { temperature: 0.6, maxTokens: 16000, deadline: Math.min(deadline, Date.now() + 200000), timeoutMs: 150000 }));
          if (j && j.youtube && typeof j.youtube === "object" && !out.youtube) out.youtube = j.youtube;
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
/** Scène SANS IA (bloc non couvert, moitié d'une scène trop longue) : jamais la phrase entière coupée par « … ».
 *  On garde la PROPOSITION la plus forte (2 à 9 mots, coupée aux virgules / « لكن » / « بل » / « mais »…) ;
 *  un pourcentage ou un nombre PRONONCÉ devient une scène chiffre animée. */
function fallbackData(text, lang, first, noStat = false) {
  const kick = pick(L.kicker, lang), raw = clean(text);
  if (!first && !noStat) {
    const m = digitsOf(raw).match(/(\d+(?:[.,٫]\d+)?)\s*(%|٪|في ?المئة|بالمئة|بالمائة|في ?المائة|pour ?cent|percent|per ?cento)/i)
      || digitsOf(raw).match(/(?<![\d.,])(\d{2,4}(?:[.,٫]\d+)?)(?![\d.,])/);
    if (m) {
      const value = Number(m[1].replace(/[,٫]/, ".")), pct = !!m[2], year = !pct && Number.isInteger(value) && value >= 1900 && value <= 2100;
      if (isFinite(value) && !year && value > 0) {
        const words = raw.split(" "), at = Math.max(0, words.findIndex((w) => digitsOf(w).includes(m[1].replace(/[,٫].*/, ""))));
        const label = clause(words.filter((w) => !/\d/.test(digitsOf(w)) && !/^(%|٪|المئة|المائة|بالمئة|بالمائة|cent|percent|cento)$/i.test(w)).join(" ").replace(/\s(في|pour|per)(?=\s|$)/gu, " ").split(" ").slice(Math.max(0, at - 4), at + 4).join(" "), 6);
        if (wc(label) >= 2) return { type: "stat", data: { kicker: kick, value, decimals: Number.isInteger(value) ? 0 : 1, prefix: "", suffix: pct ? "%" : "", label, highlight: "", fill: 0.62 + (value % 7) * 0.05 } };
      }
    }
  }
  const t = clause(raw, 9);
  return { type: first ? "hook" : "headline", data: { kicker: kick, title: t, highlight: autoHl(t) } };
}
function clause(text, max) {
  const parts = String(text).split(/[،,;؛:.!?؟]+|\s(?=(?:لكن|ولكن|بل|حيث|لأن|mais|car|donc|but|because|ma|perché)\s)/u).map((x) => clean(x)).filter((x) => wc(x) >= 2);
  if (!parts.length) return cutWords(text, max).replace(/…$/, "");
  const score = (x) => { const w = x.split(" "); return w.filter((y) => y.length >= 5).length + (/\d/.test(digitsOf(x)) ? 2 : 0) - Math.max(0, w.length - max) * 2 - (w.length < 3 ? 1 : 0); };
  const best = parts.sort((a, b) => score(b) - score(a))[0].split(" ");
  // trop long : fenêtre de max mots la plus riche (pas d'ellipse)
  const lead = /^(و|ف|ثم|بل|لكن|ولكن|et|mais|and|but|e|ma)$/iu; while (best.length > 3 && lead.test(best[0])) best.shift();
  if (best.length <= max) return best.join(" ").replace(/[.,،؛;:]+$/, "");
  let bi = 0, bs = -1; for (let i = 0; i + max <= best.length; i++) { const sc = best.slice(i, i + max).filter((y) => y.length >= 5).length; if (sc > bs) { bs = sc; bi = i; } }
  return best.slice(bi, bi + max).join(" ");
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
    if (v.type === prevType && !["headline", "hook"].includes(v.type)) { const f = fallbackData(x.r?.title || x.r?.label || text, lang, false, true); v = { type: "headline", data: { ...v.data, ...f.data } }; }
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
  const all = [...ls(["input/photos", "content/photos"], /\.(jpe?g|png|webp)$/i).map((file) => ({ kind: "img", file, p: probe(file) })),
    ...ls(["input/clips", "content/clips-src"], /\.(mp4|mov|mkv|webm|m4v|avi)$/i).map((file) => ({ kind: "vid", file, p: probe(file) }))];
  const ok = (x) => x.p && (x.kind === "img" || x.p.dur >= 0.5);
  return { imgs: all.filter((x) => x.kind === "img" && ok(x)), vids: all.filter((x) => x.kind === "vid" && ok(x)), bad: all.filter((x) => !ok(x)).map((x) => path.basename(x.file)) };
}
/** Une vidéo à monter : on vérifie ici qu'elle se décode vraiment, mais ses images ne sont extraites qu'au moment du rendu,
 *  sur la machine qui en a besoin (le plan transmis reste léger, même avec 20 vidéos). */
const checked = new Set(); let CLIPN = 0;   // chaque passage a son propre dossier d'images
function clipInfo(v, idx, maxDur, side, ss = 0) {
  if (!checked.has(v.file)) { execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", v.file, "-t", "1.5", "-an", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"], timeout: 120000 }); checked.add(v.file); }
  const dur = Math.max(0.5, Math.min(v.p.dur - ss, maxDur)), n = Math.max(1, Math.floor(dur * 30));
  return { src: rel(v.file), ss: Number(ss.toFixed(3)), dir: `content/clips/${String(++CLIPN).padStart(3, "0")}`, max: Number(dur.toFixed(3)), side, n, fps: 30, dur: n / 30 };
}
// ---------- vidéos jointes : ouverture choc, « écoutez », rythme des extraits (comme Montage LV final) ----------
// Règles reprises de Montage LV final : la vidéo COMMENCE par le passage le plus fort d'une vidéo jointe (4 à 12 s,
// phrases complètes, sous-titré) ; puis un élément (extrait, capture, photo) au moins toutes les 60 s pendant les 5
// premières minutes, ensuite environ toutes les 2 min (extraits automatiques espacés d'au moins 1 min 30) ; au moins 25 s
// entre deux extraits ; jamais deux fois le même passage ; un extrait n'est posé que dans une vraie pause, en fin de
// phrase, et seulement s'il est COHÉRENT avec ce qui est dit (mieux vaut un trou qu'un hors-sujet). Tes « écoutez » /
// « خلينا نسمع » passent toujours.
const CL = { FIRST: 300, GAP1: 60, GAP2: 120, AUTO_SEP: 90, MIN_SEP: 25, DMIN: 6, DMAX: 15, TMAX: 25, OMIN: 4, OMAX: 12, BATCH: 16 };
export function clipSentences(words) {
  return sentencesOf(sane(words, Infinity), 14).map((s) => ({ a: s.t0, b: s.t1, text: s.text }));
}
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
function clipLines(ss, budget) {
  const all = ss.map((s) => `[${s.a.toFixed(1)}-${s.b.toFixed(1)}] ${s.text}`);
  let tot = all.reduce((n, l) => n + l.length + 1, 0);
  if (tot <= budget) return all.join("\n");
  const step = tot / budget, out = [];           // trop long : lignes prises à intervalles réguliers (toute la vidéo reste représentée)
  for (let k = 0; k < all.length; k += step) out.push(all[Math.floor(k)]);
  return out.join("\n");
}
/** Bornes calées sur des phrases complètes : début de la phrase la plus proche de a0, fin entre dmin et dmax. */
export function snapPassage(ss, a0, b0, dmin, dmax, dur) {
  if (!ss.length) return null;
  let i = 0, best = Infinity;
  ss.forEach((s, k) => { const d = Math.abs(s.a - a0) + (s.a < a0 - 1 ? 2 : 0); if (d < best) { best = d; i = k; } });
  let j = i;
  while (j + 1 < ss.length && (ss[j].b - ss[i].a < dmin || ss[j + 1].b <= b0 + 0.5) && ss[j + 1].b - ss[i].a <= dmax) j++;
  const a = Math.max(0, ss[i].a - 0.15), b = Math.min(dur || Infinity, ss[j].b + 0.3, a + dmax + 0.5);
  return b - a >= Math.min(dmin, 2.5) ? [Number(a.toFixed(2)), Number(b.toFixed(2))] : null;
}
const overlaps = (used, f, a, b) => used.some((u) => u.f === f && Math.min(b, u.b) - Math.max(a, u.a) > 0.5);
/** Enveloppe sonore de la voix (énergie toutes les 10 ms) : sert à poser chaque coupure dans le creux réel d'une
 *  respiration, même courte, au lieu de se fier seulement aux horaires des mots (qui peuvent être décalés). */
export function voiceEnvelope(file) {
  try {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 29 });
    const n = Math.floor(raw.length / 160), env = new Float32Array(n);
    for (let k = 0; k < n; k++) { let e = 0; for (let q = 0; q < 80; q++) { const v = raw.readInt16LE((k * 80 + q) * 2) / 32768; e += v * v; } env[k] = Math.sqrt(e / 80); }
    const sorted = Float32Array.from(env).sort(), speech = sorted[Math.floor(n * 0.7)] || 0;   // niveau typique quand tu parles
    return { env, speech };
  } catch { return null; }
}
/** Points où un extrait peut s'insérer SANS COUPER UNE PHRASE : fin de phrase, même sur une simple respiration (dès 80 ms) ;
 *  sinon fin de proposition (virgule) avec une petite pause ; sinon pause nette entre deux groupes de mots. La coupure est
 *  posée dans le moment le plus silencieux de la respiration (vérifié sur le son) ; fo / fi = fondus qui tiennent dans le
 *  creux, pour ne jamais rogner la fin ou le début d'un mot. */
export function pausePoints(words, duration, voice = null) {
  const pts = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], nx = words[i + 1], gap = nx ? nx.t0 - w.t1 : 9;
    const end = /[.!?؟…]["»”)]*$/.test(w.w), clause = /[,،;؛:]["»”)]*$/.test(w.w);
    if (!nx) { pts.push({ t: Number(Math.min(duration, w.t1 + 0.15).toFixed(3)), fo: 0.1, fi: 0.04, strong: true }); continue; }
    if (voice) {
      // fin de phrase : on cherche la respiration dans le son même si les horaires des mots se chevauchent (ils sont
      // approximatifs) ; ailleurs, seulement là où la transcription voit déjà une pause
      if (!end && !(clause && gap >= 0.18) && !(gap >= 0.4)) continue;
      const a = Math.max(1, Math.floor((Math.min(w.t1, nx.t0) - 0.15) * 100)), b = Math.min(voice.env.length - 2, Math.ceil((Math.max(w.t1, nx.t0) + 0.15) * 100));
      const lim = voice.speech * 0.15;
      // le plus long creux (énergie sous 15 % du niveau de parole) dans la fenêtre
      let best = null;
      for (let k = a; k <= b; k++) { if (voice.env[k] > lim) continue; let r = k; while (r + 1 <= b && voice.env[r + 1] <= lim) r++; if (!best || r - k > best[1] - best[0]) best = [k, r]; k = r; }
      const need = end ? 6 : 12;                               // au moins 60 ms de vrai silence (120 ms hors fin de phrase)
      if (!best || best[1] - best[0] + 1 < need) continue;
      const [l, r] = best, t = (l + r + 1) / 200;            // milieu du creux
      pts.push({ t: Number(t.toFixed(3)), fo: Math.max(0.01, Math.min(0.15, t - l / 100 - 0.015)), fi: Math.max(0.01, Math.min(0.08, (r + 1) / 100 - t - 0.015)), strong: end });
      continue;
    }
    if (!(end && gap >= 0.08) && !(clause && gap >= 0.22) && !(gap >= 0.45)) continue;
    pts.push({ t: Number(((w.t1 + nx.t0) / 2).toFixed(3)), fo: Math.max(0.01, Math.min(0.15, gap / 2 - 0.01)), fi: Math.max(0.01, Math.min(0.08, gap / 2 - 0.01)), strong: end });
  }
  // deux mots voisins peuvent désigner le même creux : un seul point par creux
  return pts.sort((x, y) => x.t - y.t).filter((p, k, A) => !k || p.t - A[k - 1].t > 0.05);
}
/** Point d'insertion le plus proche d'un instant (annonce « écoutez ») : la respiration qui suit la phrase. */
export const nearestPoint = (pts, t, maxD = 2.5) => { let best = null; for (const p of pts) if (p.t >= t - 0.3 && Math.abs(p.t - t) <= maxD && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p; return best; };
/** Créneaux à remplir selon le rythme. fixed = instants déjà couverts (captures, photos) ; trig = annonces « écoutez ». */
export function rhythmSlots(points, fixed, trig, duration, opener) {
  points = points.map((p) => (typeof p === "number" ? { t: p, fo: 0.05, fi: 0.04, strong: true } : p));
  trig = trig.map((p) => (typeof p === "number" ? { t: p, fo: 0.05, fi: 0.04, strong: true } : p));
  const slots = trig.map((p) => ({ ...p, must: true }));
  const T = trig.map((p) => p.t);
  const ev = [...fixed.map((t) => ({ t, clip: false })), ...T.map((t) => ({ t, clip: true }))].sort((x, y) => x.t - y.t);
  let last = 0, lastClip = opener ? 0 : -1e9, guard = 0;
  while (guard++ < 2000) {
    const gap = last < CL.FIRST ? CL.GAP1 : CL.GAP2, deadline = last + gap;
    if (deadline >= duration - 8) break;
    const e = ev.find((x) => x.t > last + 0.5 && x.t <= deadline);
    if (e) { last = e.t; if (e.clip) lastClip = e.t; continue; }
    const lo = Math.max(last + CL.MIN_SEP, lastClip + (deadline > CL.FIRST ? CL.AUTO_SEP : CL.MIN_SEP), 12);
    const ok = (p) => p.t >= lo && p.t <= duration - 6 && !T.some((t) => Math.abs(t - p.t) < CL.MIN_SEP);
    const inWin = points.filter((p) => ok(p) && p.t <= deadline);
    // dans la fenêtre : de préférence une fin de phrase (la plus tardive), sinon une fin de proposition
    const strong = inWin.filter((p) => p.strong);
    const p = strong.length ? strong[strong.length - 1] : inWin.length ? inWin[inWin.length - 1] : points.find((x) => ok(x) && x.t > deadline);
    if (p === undefined) break;
    slots.push({ ...p, must: false });
    last = p.t; lastClip = p.t;
  }
  return slots.sort((a, b) => a.t - b.t);
}
const voiceAround = (words, t, before, after) => {
  const b = words.filter((w) => w.t1 <= t && w.t0 >= t - before).map((w) => w.w).join(" ");
  const a = words.filter((w) => w.t0 >= t && w.t1 <= t + after).map((w) => w.w).join(" ");
  return [b.slice(-420), a.slice(0, 260)];
};
async function askJson(list, sys, user, label, maxTokens = 4000) {
  for (const [name, fn] of list) {
    try { const j = parseJson(await fn(sys, user, { temperature: 0.3, maxTokens, deadline: Date.now() + 170000, timeoutMs: 140000 })); if (j) { console.log(`  ${label} : ${name}`); return j; } }
    catch (e) { console.log(`  ${label} — ${name} : ${String(e.message).slice(0, 140)}`); }
  }
  return null;
}
export async function pickOpener(clips, lang, subject, list) {
  const sp = clips.filter((c) => c.ss.length);
  if (!sp.length) return null;
  let choice = null;
  if (list.length && process.env.EXPLAINER_NO_LLM !== "1") {
    const txt = sp.map((c, k) => `Vidéo ${k} « ${path.basename(c.file)} » (${c.p.dur.toFixed(0)} s) :\n${clipLines(c.ss, Math.max(2500, 16000 / sp.length))}`).join("\n\n");
    const j = await askJson(list, `Tu es le monteur d'une chaîne d'analyse géopolitique (langue ${pick(L.langName, lang)}). Réponds UNIQUEMENT en JSON.`,
      `La vidéo doit COMMENCER par une OUVERTURE CHOC : le passage le plus fort, le plus choquant ou le plus saisissant d'une des vidéos ci-dessous (phrase qui choque, chiffre terrible, aveu, accusation, moment d'émotion), compréhensible seul, qui donne envie de rester. Sujet de la vidéo : ${subject}\n\n${txt}\n\nChoisis UN passage de ${CL.OMIN} à ${CL.OMAX} secondes, qui commence et finit sur une phrase complète (bornes [début-fin] ci-dessus), jamais le générique du début.\nJSON : {"video": numéro, "start": secondes, "end": secondes, "why": "pourquoi c'est le plus fort"}`, "ouverture choc");
    const c = j && sp[Math.round(Number(j.video))];
    if (c && isFinite(Number(j.start)) && Number(j.end) > Number(j.start)) choice = { c, a0: Number(j.start), b0: Number(j.end), why: cutWords(j.why, 25) };
  }
  if (!choice) {                                             // sans IA : premières phrases complètes après l'éventuel générique
    const c = sp[0], s0 = c.ss.find((s) => s.a >= 1.5) || c.ss[0];
    choice = { c, a0: s0.a, b0: s0.a + 9, why: "" };
  }
  const ab = snapPassage(choice.c.ss, choice.a0, choice.b0, CL.OMIN, CL.OMAX, choice.c.p.dur);
  return ab ? { c: choice.c, a: ab[0], b: ab[1], why: choice.why } : null;
}
/** Choisit le passage de chaque créneau (un appel IA pour 16 créneaux). Créneau obligatoire sans réponse valable : passage
 *  suivant non encore utilisé (dans l'ordre des fichiers). Créneau automatique sans passage cohérent : laissé vide. */
export async function fillSlots(slots, clips, words, used, lang, list) {
  const sp = clips.filter((c) => c.ss.length), res = [], holes = [];
  if (!sp.length) return { res, holes: slots.filter((s) => !s.must).length, mustLost: slots.filter((s) => s.must).length };
  const useAI = list.length && process.env.EXPLAINER_NO_LLM !== "1";
  for (let k0 = 0; k0 < slots.length; k0 += CL.BATCH) {
    const batch = slots.slice(k0, k0 + CL.BATCH);
    let ans = {};
    if (useAI) {
      const vids = sp.map((c, k) => `Vidéo ${k} « ${path.basename(c.file)} » (${c.p.dur.toFixed(0)} s) :\n${clipLines(c.ss, Math.max(2000, 14000 / sp.length))}`).join("\n\n");
      const sl = batch.map((s, k) => { const [bf, af] = voiceAround(words, s.t, 30, 15); return `Créneau ${k}${s.must ? " (OBLIGATOIRE : l'auteur annonce l'extrait, il faut un passage)" : ""} — à ${mmss(s.t)}\n  avant : « ${bf} »\n  après : « ${af} »`; }).join("\n");
      const j = await askJson(list, `Tu es le monteur d'une vidéo d'analyse (langue ${pick(L.langName, lang)}) pour un public de 50 ans et plus. Réponds UNIQUEMENT en JSON.`,
        `Pour garder l'attention, on insère un court passage d'une des vidéos jointes pendant une pause de l'auteur (sa voix attend, puis reprend). Pour chaque CRÉNEAU, choisis le passage qui illustre le mieux CE QUE L'AUTEUR DIT À CE MOMENT-LÀ (même sujet, même fait, même personne, même chiffre).\n\nCRÉNEAUX :\n${sl}\n\nVIDÉOS JOINTES (phrases horodatées en secondes) :\n${vids}\n\nPASSAGES DÉJÀ UTILISÉS (interdits, même en partie) : ${used.map((u) => `${path.basename(u.f)} ${u.a.toFixed(0)}-${u.b.toFixed(0)} s`).join(" ; ") || "aucun"}\n\nRègles : passage de ${CL.DMIN} à ${CL.DMAX} s (créneau obligatoire : jusqu'à ${CL.TMAX} s), qui commence au début d'une phrase et finit à la fin d'une phrase, compréhensible seul ; en rapport DIRECT avec ce que dit l'auteur juste avant, et qui s'enchaîne avec ce qu'il dit juste après ; jamais deux fois le même passage. Note ta certitude du lien de 0 à 10. Si aucun passage n'est vraiment cohérent pour un créneau non obligatoire : "video": null.\nJSON : {"slots":[{"slot": numéro, "video": numéro ou null, "start": secondes, "end": secondes, "score": 0-10}]}`, `extraits ${k0 / CL.BATCH + 1}/${Math.ceil(slots.length / CL.BATCH)}`, 3000);
      for (const r of Array.isArray(j?.slots) ? j.slots : []) ans[Math.round(Number(r?.slot))] = r;
    }
    batch.forEach((s, k) => {
      const r = ans[k];
      let got = null;
      if (r && r.video !== null && r.video !== undefined) {
        const c = sp[Math.round(Number(r.video))];
        if (c && isFinite(Number(r.start)) && (s.must || Number(r.score) >= 6)) {
          const ab = snapPassage(c.ss, Number(r.start), Number(r.end), CL.DMIN, s.must ? CL.TMAX : CL.DMAX, c.p.dur);
          if (ab && !overlaps(used, c.file, ab[0], ab[1])) got = { c, a: ab[0], b: ab[1] };
        }
      }
      if (!got && s.must) {                                // annonce entendue : on joue toujours quelque chose
        for (const c of sp) { for (const x of c.ss) { const ab = snapPassage(c.ss, x.a, x.a + 10, 8, CL.DMAX, c.p.dur); if (ab && !overlaps(used, c.file, ab[0], ab[1])) { got = { c, a: ab[0], b: ab[1] }; break; } } if (got) break; }
      }
      // annonce entendue mais tous les passages déjà montrés (vidéo jointe courte) : on rejoue le passage le plus ancien
      // plutôt que de laisser l'annonce sans rien (signalé dans le plan)
      if (!got && s.must && res.length) { const r0 = [...res].sort((x, y) => (x.reuse || 0) - (y.reuse || 0))[0]; r0.reuse = (r0.reuse || 0) + 1; got = { c: r0.c, a: r0.a, b: r0.b, reused: true }; }
      if (got) { if (!got.reused) used.push({ f: got.c.file, a: got.a, b: got.b }); res.push({ ...got, t: s.t, fo: s.fo, fi: s.fi, must: s.must }); } else holes.push(s);
    });
    if (useAI && k0 + CL.BATCH < slots.length) await new Promise((r) => setTimeout(r, Number(process.env.EXPLAINER_LLM_PAUSE_MS || 6000)));
  }
  return { res, holes: holes.filter((s) => !s.must).length, mustLost: holes.filter((s) => s.must).length };
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
  for (const x of items) { x.sentence = null; x.crop = null; x.caption = ""; x.photo = false; x.credit = x.credit || creditFromName(x.file); x.vbox = null; }
  const gem = providers().find(([n]) => n === "gemini");
  if (!items.length) return;
  const sys = `Tu es monteur. On te donne des captures d'écran, photos et vidéos (une image extraite, souvent un enregistrement d'écran de téléphone) et la voix off découpée en phrases numérotées. Réponds UNIQUEMENT en JSON : {"medias":[{"media":n,"sentence":n,"box":[ymin,xmin,ymax,xmax],"caption":"...","credit":"...","photo":true|false,"ecran":true|false}]}.
- "sentence" : numéro de la phrase où ce média illustre le mieux ce qui est DIT (titre d'article, nom, chiffre, lieu, personne citée). Chaque média DOIT recevoir une phrase : s'il n'y a pas de lien évident, choisis la phrase la plus proche par le thème. Évite de mettre plusieurs médias sur la même phrase.
- "box" : zone utile en millièmes (0 à 1000). Capture d'écran : retire barre d'état du téléphone, barre de navigation, menus, boutons, publicités, marges vides ; garde titre, texte clé, illustration. VIDÉO enregistrée depuis un téléphone : la zone EXACTE du lecteur vidéo (l'image de la vidéo seule, sans titre, commentaires, boutons, barres du téléphone). Photo ou vidéo plein cadre : [0,0,1000,1000].
- "caption" : 2 à 6 mots en ${pick(L.langName, lang)} disant ce que montre le média (sujet VISIBLE). N'invente rien. Aucun emoji.
- "credit" : la SOURCE à créditer, telle qu'elle est VISIBLE (nom du média, du site, de l'agence, de la chaîne YouTube, du compte, logo, URL) ou dans le nom du fichier ; écrite comme le média s'écrit lui-même (ex. « Al Jazeera », « Reuters », « العربية »). Vide si aucune source n'est lisible : n'invente jamais.
- "photo" : true si c'est une photographie sans texte important, false pour capture d'écran, article, document, publication.
- "ecran" (vidéos seulement) : true UNIQUEMENT si c'est l'ENREGISTREMENT D'UN ÉCRAN de téléphone ou d'ordinateur où l'on voit l'interface autour de la vidéo (barre d'état avec l'heure et la batterie, boutons j'aime / partager, titre ou commentaires sous le lecteur, barre de navigation). false pour une vidéo normale plein cadre, même avec des bandeaux, des titres incrustés ou un décor fixe (reportage, interview, motion design, journal TV).`;

  // PAR LOTS de 8 médias (et non un seul gros appel) : un modèle surchargé ou lent ne fait perdre qu'un lot, qui est
  // retenté une fois ; budget global 7 min. Ce qu'aucun lot n'a pu relier passe au repli LECTURE DU TEXTE (OCR).
  const all = items.slice(0, 60), T0 = Date.now(), BUDGET = 7 * 60 * 1000;
  if (gem && process.env.EXPLAINER_NO_LLM !== "1") {
    const batches = []; for (let i = 0; i < all.length; i += 8) batches.push(all.slice(i, i + 8));
    const todo = batches.map((b) => ({ b, tries: 0 }));
    while (todo.length) {
      const job = todo.shift(), sub = job.b, left = T0 + BUDGET - Date.now();
      if (left < 40000) { console.log("  médias : budget IA épuisé → repli lecture du texte pour le reste"); break; }
      const parts = [];
      sub.forEach((x, i) => { try { const src = x.kind === "vid" ? (x.orig || x.file) : x.file, at = x.kind === "vid" ? Math.min((x.origDur || x.p.dur) / 2, 4) : 0;
        parts.push({ text: `Média ${i} (${x.kind === "vid" ? "vidéo (enregistrement d'écran possible), image extraite" : "image"}) — fichier « ${path.basename(x.orig || x.file)} » :` }, { inlineData: { mimeType: "image/jpeg", data: thumb(src, at).toString("base64") } }); } catch { /* miniature impossible */ } });
      try {
        const j = parseJson(await gem[1](sys, `Phrases :\n${sents.map((s) => `${s.i} | ${s.text}`).join("\n")}`, { parts, temperature: 0.2, maxTokens: 4000, thinking: 0, deadline: Date.now() + Math.min(150000, left), timeoutMs: 80000 }));
        applyMedia(sub, j, sents);
      } catch (e) {
        console.log(`  médias lot ${batches.indexOf(sub) + 1}/${batches.length} : échec (${String(e.message).slice(0, 90)})${job.tries ? "" : " → retenté à la fin"}`);
        if (!job.tries++) todo.push(job);
      }
    }
    console.log(`  médias analysés par Gemini : ${items.filter((x) => x.sentence !== null).length}/${items.length} reliés à une phrase, ${items.filter((x) => x.crop).length} recadrés, ${items.filter((x) => x.credit).length} source(s) à créditer`);
  } else console.log("  médias : pas de clé Gemini → repli lecture du texte (OCR)");
  ocrFallback(items.filter((x) => x.sentence === null && x.kind === "img"), sents);
}
function applyMedia(sub, j, sents) {
  for (const r of Array.isArray(j?.medias) ? j.medias : []) {
    const x = sub[Math.round(Number(r?.media))]; if (!x) continue;
    const sn = Math.round(Number(r.sentence)); if (isFinite(sn) && sn >= 0 && sn < sents.length) x.sentence = sn;
    const b = (Array.isArray(r.box) ? r.box : []).map(Number);
    if (b.length === 4 && b.every((v) => isFinite(v))) {
      const [y0, x0, y1, x1] = b.map((v) => Math.max(0, Math.min(1000, v)) / 1000);
      // recadrage accepté seulement s'il est plausible (ni minuscule ni inversé, ni « tout ») — sinon image entière
      const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (x.kind === "img" && y1 - y0 >= 0.25 && x1 - x0 >= 0.4 && (y1 - y0 < 0.985 || x1 - x0 < 0.985)) x.crop = box;
      if (x.kind === "vid" && box.w >= 0.3 && box.h >= 0.12 && box.w * box.h < 0.92) x.vbox = box;
    }
    x.caption = cutWords(r.caption, 7); x.photo = r.photo === true;
    if (x.kind === "vid" && typeof r.ecran === "boolean") x.ecran = r.ecran;
    const cr = clean(r.credit, 40); if (cr && !/^(inconnu|unknown|aucun|none|n\/a|-)$/i.test(cr)) x.credit = cr;
  }
}
/** Repli SANS IA : le texte des captures (titres d'articles, tweets…) est lu par Tesseract (arabe + français + anglais)
 *  et la capture est posée sur la phrase qui partage le plus de mots rares avec ce texte. Recadrage : marges unies
 *  et barres du téléphone retirées par analyse des lignes de pixels. Sans Tesseract : pose dans l'ordre (comme avant). */
export function ocrFallback(list, sents) {
  if (!list.length) return;
  let ok = true; try { execFileSync("tesseract", ["--version"], { stdio: "ignore" }); } catch { ok = false; }
  const norm = (t) => String(t).toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").map((w) => w.replace(/^(ال|وال|بال|لل|فال)(?=\p{L}{3})/u, "")).filter((w) => w.length >= 3);
  const df = new Map(); const sw = sents.map((s) => { const set = new Set(norm(s.text)); for (const w of set) df.set(w, (df.get(w) || 0) + 1); return set; });
  const used = new Set(); let hits = 0;
  for (const x of list) {
    if (ok) try {
      const txt = execFileSync("tesseract", [x.file, "-", "-l", "ara+fra+eng", "--psm", "3"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000, maxBuffer: 1 << 22 });
      const words = new Set(norm(txt));
      let best = -1, bs = 0;
      sw.forEach((set, i) => { let sc = 0; for (const w of words) if (set.has(w)) sc += Math.log(1 + sents.length / (df.get(w) || 1)); if (used.has(i)) sc *= 0.5; if (sc > bs) { bs = sc; best = i; } });
      if (best >= 0 && bs >= 4) { x.sentence = sents[best].i; used.add(best); hits++; }
    } catch { /* image illisible par Tesseract */ }
    if (!x.crop) { const c = autoTrim(x.file); if (c) x.crop = c; }
  }
  console.log(`  repli lecture du texte : ${ok ? `${hits}/${list.length} capture(s) reliée(s) à la phrase qui en parle` : "Tesseract absent"} ; le reste est posé dans l'ordre, réparti sur la durée`);
}
/** Recadrage sans IA : retire les bandes uniformes (marges, barre d'état noire/blanche) en haut, en bas et sur les côtés. */
export function autoTrim(file) {
  try {
    const W = 200, H = 400;
    const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${W}:${H},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 22 });
    const busy = (vals) => { let m = 0; for (const v of vals) m += v; m /= vals.length; let d = 0; for (const v of vals) d += Math.abs(v - m); return d / vals.length > 6; };
    const row = (y) => busy(buf.subarray(y * W, (y + 1) * W)), col = (x) => { const a = []; for (let y = 0; y < H; y++) a.push(buf[y * W + x]); return busy(a); };
    let y0 = 0, y1 = H - 1, x0 = 0, x1 = W - 1;
    while (y0 < H / 3 && !row(y0)) y0++; while (y1 > H * 2 / 3 && !row(y1)) y1--;
    while (x0 < W / 4 && !col(x0)) x0++; while (x1 > W * 3 / 4 && !col(x1)) x1--;
    const box = { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
    return box.w * box.h < 0.97 && box.w >= 0.4 && box.h >= 0.25 ? box : null;
  } catch { return null; }
}
// source lisible dans le nom du fichier (« aljazeera-ministre.mp4 », « Reuters_2026.jpg ») ; jamais les noms automatiques
const GENERIQUE = /^(screen|scr|record|rec|enregistr|capture|vid|video|img|image|photo|pxl|dsc|mov|whatsapp|wa\d|signal|telegram|snapchat|tiktok_?\d|\d)/i;
const MEDIAS = { "al jazeera": "Al Jazeera", "aljazeera": "Al Jazeera", "الجزيرة": "الجزيرة", "al arabiya": "Al Arabiya", "alarabiya": "Al Arabiya",
  "العربية": "العربية", "sky news": "Sky News", "skynews": "Sky News", "bbc": "BBC", "cnn": "CNN", "reuters": "Reuters", "afp": "AFP", "ap": "AP",
  "bloomberg": "Bloomberg", "france 24": "France 24", "france24": "France 24", "rt": "RT", "trt": "TRT", "fox news": "Fox News", "foxnews": "Fox News",
  "cnbc": "CNBC", "financial times": "Financial Times", "ft": "Financial Times", "le monde": "Le Monde", "lemonde": "Le Monde", "le figaro": "Le Figaro",
  "nytimes": "The New York Times", "new york times": "The New York Times", "washington post": "The Washington Post", "guardian": "The Guardian",
  "asharq": "Asharq", "الشرق": "الشرق", "spa": "SPA", "wam": "WAM", "kuna": "KUNA", "qna": "QNA", "ona": "ONA", "bna": "BNA" };
function creditFromName(file) {
  const stem = path.basename(String(file || "")).replace(/\.[^.]+$/, "").replace(/^\d+[-_. ]*/, "");
  if (!stem || GENERIQUE.test(stem)) return "";
  const low = " " + stem.toLowerCase().replace(/[-_.]+/g, " ") + " ";
  const hit = Object.keys(MEDIAS).sort((a, b) => b.length - a.length).find((m) => low.includes(` ${m} `));
  return hit ? MEDIAS[hit] : "";
}
const SRC_LABEL = { ar: "المصدر", fr: "Source", en: "Source", it: "Fonte" };
const creditLine = (list, lang) => { const c = [...new Set(list.map((x) => x.credit).filter(Boolean))].slice(0, 3); return c.length ? `${SRC_LABEL[lang] || SRC_LABEL.en} : ${c.join(" · ")}` : ""; };
const mediaData = (x) => (x.kind === "vid" ? { kind: "vid", ...x.frames, iw: x.p.w, ih: x.p.h } : { kind: "img", image: rel(x.file), iw: x.p.w, ih: x.p.h, crop: x.crop });
/** Pose TOUS les médias (aucun n'est jamais écarté) : d'abord sur la scène de leur phrase, sinon répartis sur les scènes
 *  libres ; s'il y a plus de médias que de scènes, plusieurs médias se partagent une scène (ils s'enchaînent en fondu). */
let LANG_OF_PLAN = "ar";
export function placeMedia(scenes, items, lang = LANG_OF_PLAN) {
  LANG_OF_PLAN = lang;
  if (!items.length || !scenes.length) return 0;
  const body = scenes.map((_, i) => i).filter((i) => scenes[i].type !== "outro" && !scenes[i].big);
  const pool = body.length > 1 ? body.slice(1) : body;                       // l'accroche est épargnée tant que c'est possible
  // médias déjà posés (2e appel) : comptés, et les nouveaux s'ajoutent à la suite (rien n'est remplacé)
  const pre = new Map(pool.map((i) => [i, scenes[i].type === "photo" ? 99 : (scenes[i].data?.media || []).length]));
  const load = new Map(pool.map((i) => [i, []]));
  const n = (i) => pre.get(i) + load.get(i).length;
  const cap = (i) => Math.max(1, Math.floor((scenes[i].t1 - scenes[i].t0) / 2.4));   // ≥ 2,4 s par média tant que possible
  const rest = [];
  for (const x of items) {
    if (x.sentence === null || x.sentence === undefined) { rest.push(x); continue; }
    const i = scenes.findIndex((s) => s.from <= x.sentence && x.sentence <= s.to);
    const c = [i, i + 1, i - 1, i + 2, i - 2].find((k) => load.has(k) && n(k) === 0) ?? [i, i + 1, i - 1].find((k) => load.has(k) && n(k) < cap(k));
    if (c === undefined) rest.push(x); else load.get(c).push(x);
  }
  // le reste : scènes vides réparties régulièrement, puis scènes ayant encore de la place, puis la moins chargée (garantie)
  const empty = pool.filter((i) => n(i) === 0);
  rest.forEach((x, k) => {
    let i;
    if (k < empty.length) i = empty[Math.min(empty.length - 1, Math.floor(((k + 0.5) * empty.length) / Math.min(rest.length, empty.length)))];
    if (i === undefined || n(i)) i = pool.find((p) => n(p) === 0) ?? pool.filter((p) => n(p) < cap(p)).sort((a, b) => n(a) - n(b))[0]
      ?? [...pool].sort((a, b) => n(a) / (scenes[a].t1 - scenes[a].t0) - n(b) / (scenes[b].t1 - scenes[b].t0))[0];
    load.get(i).push(x);
  });
  let used = 0;
  for (const [i, list] of load) {
    if (!list.length) continue;
    const s = scenes[i], d = s.data, first = list[0];
    if (s.type === "shot" && Array.isArray(d.media) && d.media.length) { d.media = [...d.media, ...list.map(mediaData)]; used += list.length; continue; }
    if (s.type === "photo") { d.media = [{ kind: "img", image: d.photo, iw: 0, ih: 0, crop: null }, ...list.map(mediaData)]; s.type = "shot"; delete d.photo; used += list.length; continue; }
    const title = d.title || d.label || d.quote || [d.a, d.b].filter(Boolean).join(" · ") || first.caption;
    // crédit de la source affiché sous le média (« المصدر : الجزيرة ») ; sinon la légende, comme avant
    const source = creditLine(list, LANG_OF_PLAN) || first.caption || d.source;
    if (list.length === 1 && first.kind === "img" && first.photo && !first.crop) { s.type = "photo"; s.data = { kicker: d.kicker, context: d.context, source, title: cutWords(title, 11), highlight: d.highlight, photo: rel(first.file) }; }
    else { s.type = "shot"; s.data = { kicker: d.kicker, context: d.context, source, title: cutWords(title, 14), highlight: d.highlight, media: list.map(mediaData) }; }
    used += list.length;
  }
  return used;
}
/** Insère les vidéos « à écouter » : la scène en cours est coupée à l'instant voulu, la vidéo joue (avec son son), puis la
 *  scène reprend là où elle en était. Tous les horaires qui suivent sont décalés. Renvoie le plan audio. */
/** Vidéos « à écouter » : quelle vidéo pour quel mot déclencheur ? D'après le CONTENU — ce que tu dis juste avant le mot
 *  (« voilà ce qu'a dit le ministre… اسمعوا ») comparé au début de chaque vidéo (transcrit) et à son nom de fichier.
 *  Un seul appel IA ; sans IA : mots communs ; en dernier recours : ordre des noms de fichiers (comme avant).
 *  Renvoie [{ trig, vid, how }] — une vidéo au plus par mot déclencheur, une vidéo n'est jamais jouée deux fois. */
const toks = (s) => new Set(normTrig(s).split(" ").filter((w) => w.length > 2));
export async function matchTriggers(trig, vids, sents, { llm = providers(), asr = transcribeStart } = {}) {
  if (!trig.length || !vids.length) return [];
  const n = Math.min(trig.length, vids.length);
  const order = trig.slice(0, n).map((t, k) => ({ trig: t, vid: k, how: "ordre des fichiers" }));
  if (vids.length === 1 && trig.length === 1) return [{ ...order[0], how: "seule vidéo" }];
  // contexte = ce qui est dit depuis le mot déclencheur précédent (au plus 3 phrases avant celui-ci)
  const ctx = trig.map((t, k) => sents.slice(Math.max(0, t - 3, k ? trig[k - 1] + 1 : 0), t + 1).map((x) => x.text).join(" ").slice(-500));
  const desc = [];
  for (const v of vids) {
    const name = path.basename(v.file).replace(/\.[^.]+$/, "").replace(/^\d+[-_. ]*/, "").replace(/[-_]+/g, " ");
    const heard = v.heardText ?? (v.heardText = await asr(v.file).catch(() => ""));
    desc.push({ name, heard });
  }
  const used = new Set(), out = new Map();
  // 1) l'IA (texte seul : léger) associe chaque mot déclencheur à la vidéo dont le contenu correspond
  const sys = `Tu es monteur vidéo. Le présentateur dit un mot déclencheur (« écoutez », « اسمعوا »…) pour faire écouter un extrait vidéo. Pour chaque mot déclencheur, on te donne ce qu'il dit JUSTE AVANT ; pour chaque vidéo, son nom de fichier et le début de ce qu'on y entend. Associe à chaque mot déclencheur la vidéo qu'il annonce (personne, sujet, événement, citation). Une vidéo ne sert qu'une fois. Si rien ne correspond clairement, mets "video": null. Réponds UNIQUEMENT en JSON : {"assign":[{"trigger":n,"video":n|null,"sur":0-100}]}`;
  const user = `MOTS DÉCLENCHEURS :\n${ctx.map((c, k) => `T${k} : « …${c} »`).join("\n")}\n\nVIDÉOS :\n${desc.map((d, k) => `V${k} : fichier « ${d.name} » ; on entend : « ${d.heard || "(son non transcrit)"} »`).join("\n")}\n\nRéponds avec les numéros (trigger: 0 pour T0, video: 2 pour V2).`;
  for (const [name, fn] of llm) {
    try {
      const j = parseJson(await fn(sys, user, { temperature: 0.1, maxTokens: 1500, deadline: Date.now() + 120000, timeoutMs: 90000 }));
      for (const a of Array.isArray(j?.assign) ? j.assign : []) {
        const t = Math.round(Number(a?.trigger)), v = a?.video === null ? NaN : Math.round(Number(a?.video));
        if (!(t >= 0 && t < trig.length) || !(v >= 0 && v < vids.length) || used.has(v) || out.has(t) || Number(a?.sur ?? 100) < 50) continue;
        out.set(t, { trig: trig[t], vid: v, how: `contenu (IA ${name})` }); used.add(v);
      }
      if (out.size) break;
    } catch (e) { console.log(`  vidéos à écouter : IA ${name} indisponible (${String(e.message).slice(0, 80)})`); }
  }
  // 2) sans IA (ou pour ce qu'elle n'a pas tranché) : mots communs entre le contexte et le contenu de la vidéo
  const pairs = [];
  ctx.forEach((c, t) => { if (out.has(t)) return; const a = toks(c); desc.forEach((d, v) => { if (used.has(v)) return; const b = toks(`${d.name} ${d.heard}`); let sc = 0; for (const w of a) if (b.has(w)) sc++; if (sc >= 2) pairs.push({ t, v, sc }); }); });
  for (const p of pairs.sort((x, y) => y.sc - x.sc)) if (!out.has(p.t) && !used.has(p.v)) { out.set(p.t, { trig: trig[p.t], vid: p.v, how: `contenu (mots communs : ${p.sc})` }); used.add(p.v); }
  // 3) le reste : ordre des noms de fichiers parmi les vidéos encore libres (comportement d'avant)
  const free = vids.map((_, v) => v).filter((v) => !used.has(v));
  trig.forEach((t, k) => { if (!out.has(k) && free.length && out.size < vids.length) out.set(k, { trig: t, vid: free.shift(), how: "ordre des fichiers" }); });
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x);
}
export function insertClips(scenes, inserts, lang) {
  const cuts = []; let shift = 0;
  for (const ins of [...inserts].sort((a, b) => a.vt - b.vt)) {
    let at = ins.vt + shift;
    let i = scenes.findIndex((s) => s.t0 <= at && at < s.t1); if (i < 0) i = scenes.length - 1;
    const s = scenes[i];
    // la coupure reste dans la pause (jamais au milieu d'un mot) ; un bout de scène de moins d'1 s est rendu à la voisine
    const source = ins.credit ? `${SRC_LABEL[lang] || SRC_LABEL.en} : ${ins.credit}` : "";   // jamais le nom du fichier (« default », « low.salary.ksa »…)
    const clip = { type: "shot", t0: at, t1: at + ins.dur, big: true, opener: !!ins.opener, transition: ins.opener ? "open" : "zoom", data: { kicker: ins.opener ? "" : pick(L.listen, lang), source, media: [ins.media] } };
    let idx;
    if (at === s.t1) idx = i + 1; else if (at === s.t0) idx = i;
    else if (at - s.t0 < 1.0 && i > 0) { scenes[i - 1].t1 = at; s.t0 = at; idx = i; }
    else if (s.t1 - at < 1.0 && i < scenes.length - 1) { s.t1 = at; scenes[i + 1].t0 = at; idx = i + 1; }
    else { const span = s.span || s.t1 - s.t0, off = s.offset || 0; scenes.splice(i, 1, { ...s, t1: at, span }, { ...s, t0: at, offset: off + (at - s.t0), span, transition: "cut" }); idx = i + 1; }
    scenes.splice(idx, 0, clip);
    for (let k = idx + 1; k < scenes.length; k++) { scenes[k].t0 += ins.dur; scenes[k].t1 += ins.dur; }
    cuts.push({ voiceAt: at - shift, at, dur: ins.dur, file: ins.file, name: ins.name || "", ss: ins.ss || 0, audio: ins.audio, opener: !!ins.opener, fo: ins.fo, fi: ins.fi });
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
  for (const s of scenes) { if (s.country && s.country !== th.code) s.accent = sceneAccent(s.country); if (s.country) s.chip = countryChip(s.country, lang); }
  const base = Number(QUALITY) >= 2160 ? 2160 : Number(QUALITY) >= 1440 ? 1440 : 1080;

  // --- médias fournis : captures / photos / vidéos. TOUS sont insérés.
  const { imgs, vids, bad } = listMedia(); const notes = bad.map((b) => `⚠ média illisible ou trop court, ignoré : ${b}`);
  try { const vc = readFileSync("input/voice-choice.txt", "utf8").trim(); if (vc) notes.unshift(vc); } catch { /* voix venue d'un lien : rien à dire */ }
  const side = base >= 2160 ? 1440 : 960, CLIP_MAX = Number(process.env.EXPLAINER_CLIP_MAX_S || 180);   // ton enregistrement annoncé = joué en entier (3 min max)
  const list = process.env.EXPLAINER_NO_LLM === "1" ? [] : providers(), used = [], inserts = [], broll = [];
  // 0) enregistrements d'écran BRUTS du téléphone : recadrés sur le lecteur vidéo et débarrassés du début / de la fin
  //    hors vidéo (ouverture de l'appli, défilement, arrêt de l'enregistrement) ; une vidéo normale n'est pas touchée
  for (const v of vids) {
    v.orig = v.file; v.origDur = v.p.dur;
    const r = prepClip(v);
    if (r.file !== v.file) { const p2 = probe(r.file); if (p2 && p2.dur >= 0.5) { v.file = r.file; v.p = p2; } }
    v.prep = r; for (const n of r.notes) notes.push(`✂ ${path.basename(v.orig)} : ${n}`);
  }
  const okVids = vids.filter((v) => { try { v.frames = clipInfo(v, 0, CLIP_MAX, side); return true; } catch (e) { notes.push(`⚠ vidéo illisible ignorée : ${path.basename(v.orig || v.file)}`); return false; } });
  // 1) UN SEUL appel Gemini pour TOUS les médias : phrase illustrée, recadrage, légende, SOURCE à créditer ; pour une
  //    vidéo dont le lecteur n'a pas pu être repéré par le mouvement, Gemini donne la zone du lecteur → recadrage
  await analyseMedia([...imgs, ...okVids], sents, lang);
  okVids.forEach((v) => {
    // l'IA voit une vidéo NORMALE là où la préparation avait recadré / découpé : on revient à l'original intact
    if (v.ecran === false && v.file !== v.orig && v.prep?.status !== "normale") {
      const p0 = probe(v.orig);
      if (p0) { v.file = v.orig; v.p = p0; v.prep = { ...v.prep, status: "normale", t0: 0, t1: p0.dur }; try { v.frames = clipInfo(v, 0, CLIP_MAX, side); } catch { /* original déjà vérifié lisible */ }
        notes.push(`✂ ${path.basename(v.orig)} : l'IA y voit une vidéo normale → gardée entière, sans recadrage ni découpe`); }
      return;
    }
    // l'IA voit un enregistrement d'écran là où les indices disaient « vidéo normale » : recadrage sur le lecteur qu'elle a repéré
    if (v.prep?.status === "normale" && v.ecran === true && v.vbox) {
      const r = prepClip({ file: v.orig, p: probe(v.orig) }, "content/clips-prep", { box: v.vbox });
      const p2 = r.file !== v.orig ? probe(r.file) : null;
      if (p2 && p2.dur >= 0.5) { v.file = r.file; v.p = p2; v.prep = { ...v.prep, ...r }; try { v.frames = clipInfo(v, 0, CLIP_MAX, side); notes.push(`✂ ${path.basename(v.orig)} : enregistrement d'écran repéré par l'IA, recadré sur le lecteur`); } catch { /* garde l'original */ } }
      return;
    }
    if (v.prep?.status !== "incertain" || !v.vbox) return;
    const r = prepClip({ file: v.orig, p: probe(v.orig) }, "content/clips-prep", { box: v.vbox, t0: v.prep.t0, t1: v.prep.t1 });
    const p2 = r.file !== v.orig ? probe(r.file) : null;
    if (p2 && p2.dur >= 0.5) { v.file = r.file; v.p = p2; v.prep = { ...v.prep, ...r }; try { v.frames = clipInfo(v, 0, CLIP_MAX, side); notes.push(`✂ ${path.basename(v.orig)} : lecteur repéré par l'IA, recadrée`); } catch { /* garde la version précédente */ } }
  });
  // 2) paroles des vidéos (content/clips-asr.json, transcrites sur le fichier d'ORIGINE) → recalées sur la vidéo préparée
  //    (début coupé par la préparation) ; servent à choisir les passages, à les sous-titrer et à relier vidéo et annonce
  let asr = {}; try { asr = JSON.parse(readFileSync("content/clips-asr.json", "utf8")); } catch { /* pas de transcription : images seulement */ }
  for (const v of okVids) {
    const a = asr[path.basename(v.orig || v.file)], off = v.file !== v.orig && v.prep && Number(v.prep.t0) > 0 ? Number(v.prep.t0) : 0;
    const ws = v.p.audio && a && Array.isArray(a.words) ? a.words.map((w) => ({ ...w, t0: Number(w.t0) - off, t1: Number(w.t1) - off })).filter((w) => w.t0 >= 0 && w.t1 <= v.p.dur + 0.3) : [];
    v.ss = ws.length >= 4 ? clipSentences(ws) : [];
    if (ws.length) v.heardText = ws.slice(0, 70).map((w) => w.w).join(" ");      // évite une 2e transcription pour l'association
  }
  const speech = okVids.filter((v) => v.ss.length);
  const subsOf = (c, a, b) => c.ss.filter((x) => x.b > a + 0.2 && x.a < b - 0.2).map((x) => ({ t0: Number(Math.max(0, x.a - a).toFixed(2)), t1: Number(Math.min(b - a, x.b - a).toFixed(2)), text: clean(x.text, 160) }));
  const mk = (c, a, b, extra) => {
    const m = { ...clipInfo(c, 0, b - a, side, a), kind: "vid", iw: c.p.w, ih: c.p.h, subs: subsOf(c, a, b) };
    return { dur: m.dur, ss: a, media: m, file: rel(c.file), name: path.basename(c.orig || c.file), audio: true, credit: c.credit || "", label: cutWords(path.basename(c.orig || c.file).replace(/\.[^.]+$/, "").replace(/^\d+[-_ ]*/, "").replace(/[_-]+/g, " "), 6), ...extra };
  };
  // 3) respirations de la voix : seuls endroits où un extrait peut couper ta parole (jamais au milieu d'un mot)
  const venv = voiceEnvelope(process.env.EXPLAINER_VOICE_FILE || "input/voice.wav");
  const pts = pausePoints(words, duration, venv);
  const at = (k) => { const sn = sents[k], nx = sents[k + 1]; return nearestPoint(pts, sn.t1) || { t: nx ? Number(((sn.t1 + nx.t0) / 2).toFixed(3)) : duration, fo: 0.03, fi: 0.03, strong: true }; };
  // 4) mots déclencheurs (« écoutez », « خلينا نسمع »…) : la vidéo annoncée choisie d'après son CONTENU, jouée en entier
  const trig = process.env.EXPLAINER_TRIGGERS === "non" ? [] : triggerSentences(sents);
  const assign = !list.length ? (trig.length ? okVids.slice(0, trig.length).map((_, k) => ({ trig: trig[k], vid: k, how: "ordre des fichiers" })) : [])
    : await matchTriggers(trig, okVids, sents).catch((e) => { console.log(`  association des vidéos impossible (${e.message}) : ordre des fichiers`); return okVids.slice(0, trig.length).map((_, k) => ({ trig: trig[k], vid: k, how: "ordre des fichiers" })); });
  const heardVid = new Map(assign.map((a) => [a.vid, a])), reserved = new Set();
  okVids.forEach((v, k) => {
    const a = heardVid.get(k); if (!a) return;
    reserved.add(v.file);
    const dur = Math.min(v.p.dur, CLIP_MAX), p = at(a.trig);
    inserts.push({ ...mk(v, 0, dur, {}), vt: p.t, fo: p.fo, fi: p.fi, audio: v.p.audio });
    used.push({ f: v.file, a: 0, b: dur });
    notes.push(`▶ « ${clean(sents[a.trig].text, 60)} » → ${path.basename(v.orig || v.file)} (choisie selon : ${a.how}${v.credit ? ` ; source : ${v.credit}` : ""})`);
    if (v.p.dur > CLIP_MAX + 0.5) notes.push(`⚠ ${path.basename(v.orig || v.file)} : ${v.p.dur.toFixed(0)} s, joué ${CLIP_MAX} s`);
  });
  const unserved = trig.filter((t) => !assign.some((a) => a.trig === t));
  // 5) ouverture choc : le passage le plus fort d'une vidéo jointe (de préférence une vidéo qui n'est pas annoncée plus loin)
  let opener = null;
  if (speech.length && process.env.EXPLAINER_OPENER !== "non") {
    const pool = speech.filter((v) => !reserved.has(v.file)), subject = scenes[0]?.data?.title || sents.slice(0, 3).map((x) => x.text).join(" ").slice(0, 300);
    opener = await pickOpener(pool.length ? pool : speech, lang, subject, list);
    if (opener) { if (!reserved.has(opener.c.file)) used.push({ f: opener.c.file, a: opener.a, b: opener.b }); inserts.push(mk(opener.c, opener.a, opener.b, { vt: 0, opener: true }));
      notes.push(`⚡ ouverture choc : ${path.basename(opener.c.orig || opener.c.file)} de ${mmss(opener.a)} à ${mmss(opener.b)}${opener.why ? ` — ${opener.why}` : ""}${reserved.has(opener.c.file) ? " (cette vidéo est aussi jouée en entier plus loin, sur ton annonce)" : ""}`); }
  } else if (!okVids.length) notes.push("⚡ pas d'ouverture choc : aucune vidéo jointe");
  else if (!speech.length) notes.push("⚡ pas d'ouverture choc : les vidéos jointes n'ont pas de paroles");
  // 6) captures, photos et vidéos sans paroles : posées là où tu en parles — aucune n'est écartée
  for (const v of okVids) if (!v.ss.length && !reserved.has(v.file)) { v.frames = clipInfo(v, 0, 20, side); broll.push(v); }
  const items = [...imgs, ...broll];
  const placed = placeMedia(scenes, items, lang);
  // 7) rythme (comme Montage LV) : un élément au moins toutes les 60 s puis toutes les 2 min ; passages des vidéos à
  //    paroles NON annoncées (une vidéo annoncée est jouée en entier : on ne la découpe pas) ; annonces sans vidéo
  //    attribuée = créneaux obligatoires
  const rpool = speech.filter((v) => !reserved.has(v.file));
  const fixed = scenes.filter((x) => x.type === "shot" || x.type === "photo").map((x) => x.t0);
  let slots = rhythmSlots(pts, fixed, trig.map(at), duration, !!opener).filter((x) => !x.must);
  if (process.env.EXPLAINER_RHYTHM === "non") slots = [];
  slots = [...slots, ...unserved.map((k) => ({ ...at(k), must: true }))].sort((x, y) => x.t - y.t);
  const fill = await fillSlots(slots, rpool.length ? rpool : speech, words, used, lang, list);
  for (const r of fill.res) inserts.push(mk(r.c, r.a, r.b, { vt: r.t, must: r.must, fo: r.fo, fi: r.fi }));
  if (slots.length) notes.push(`🎞️ rythme des extraits : ${fill.res.filter((r) => !r.must).length} extrait(s) ajouté(s)${unserved.length ? ` · ${fill.res.filter((r) => r.must).length}/${unserved.length} annonce(s) sans vidéo attribuée servie(s) par un passage` : ""}${fill.holes ? ` · ${fill.holes} créneau(x) laissé(s) vide(s) : aucun passage vraiment cohérent${list.length ? "" : " (pas d'IA pour les choisir)"}${rpool.length ? "" : " (toutes tes vidéos à paroles sont annoncées : elles sont jouées en entier)"}` : ""}`);
  if (fill.res.some((r) => r.reused)) notes.push(`⚠ ${fill.res.filter((r) => r.reused).length} annonce(s) ont rejoué un passage déjà montré : pas assez de vidéo pour toutes tes annonces`);
  if (fill.mustLost) notes.push(`⚠ ${fill.mustLost} annonce(s) « écoutez » sans extrait : ${!speech.length ? "aucune vidéo jointe avec paroles" : "plus d'annonces que de vidéos (chaque vidéo annoncée est déjà jouée en entier) — dépose une vidéo par annonce"}`);
  for (const x of [...imgs, ...okVids]) if (x.credit) notes.push(`© ${path.basename(x.orig || x.file)} : source affichée « ${x.credit} »`);
  // 8) vidéos à paroles jamais montrées : posées en image (sans leur son) pour que chaque pièce jointe apparaisse
  const shown = new Set([...used.map((u) => u.f), ...reserved]);
  const rest = speech.filter((v) => !shown.has(v.file));
  if (rest.length) { rest.forEach((v) => { v.frames = clipInfo(v, 0, 20, side); v.sentence = null; }); placeMedia(scenes, rest, lang); }
  const broll2 = [...broll, ...rest];
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
  // bandeau défilant (format horizontal) : les idées fortes de la vidéo, dans l'ordre, comme une chaîne d'information
  const ticker = [...new Set(scenes.filter((x) => !x.big && x.type !== "outro").map((x) => cutWords(x.data.title || x.data.label || x.data.quote || "", 9).replace(/[.…]+$/, "")).filter((x) => wc(x) >= 2))].slice(0, 60);
  const spec = { w, h, fps: 30, maxrateK, ticker, tickerLabel: pick(L.kicker, lang), grain: total <= 20 * 60, duration: Math.round(total * 30) / 30, voice: duration, voiceEnd: total0, cuts, lang, dir: RTL(lang) ? "rtl" : "ltr", seed: hash(full), themeCode: th.code, theme: th.theme,
    logo, logoAlpha: logo ? hasAlpha(logo) : false, channel: ch.nom || "", crf: base >= 2160 ? 21 : 19, scenes };
  mkdirSync(path.dirname(OUT), { recursive: true });
  for (const f of ["vertical", "horizontal"]) { const p = OUT.replace(/\.json$/, `-${f}.json`); if (existsSync(p)) rmSync(p); }
  // chaque format a son propre écran de fin (durée différente) : même plan, seule la dernière scène change
  const PART = Number(process.env.EXPLAINER_PART_S || 240) * 30, matrix = [];
  for (const f of formats) {
    const extra = withOutro && f === "horizontal" ? OUTRO_H - OUTRO : 0;
    const sc = scenes.map((x) => (x.type === "outro" ? { ...x, t1: x.t1 + extra } : x));
    const one = { ...spec, format: f, w: f === "horizontal" ? long : base, h: f === "horizontal" ? base : long, duration: Math.round((total + extra) * 30) / 30, scenes: sc };
    writeFileSync(OUT.replace(/\.json$/, `-${f}.json`), JSON.stringify(one, null, 1));
    const N = Math.round(one.duration * 30), nParts = Math.max(1, Math.ceil(N / PART));
    for (let k = 0; k < nParts; k++) matrix.push({ format: f, part: String(k + 1).padStart(3, "0"), f0: Math.floor((N * k) / nParts), f1: Math.floor((N * (k + 1)) / nParts) });
  }
  writeFileSync(OUT, JSON.stringify(spec, null, 1));
  writeFileSync("content/matrix.json", JSON.stringify(matrix));
  // fiche YouTube : reprise du plan (0 appel de plus) ou un petit appel à part ; sans IA, fiche tirée de la voix elle-même
  let ytRaw = raw && raw.youtube ? raw.youtube : null;
  if (!ytRaw || !ytRaw.title || !ytRaw.description) ytRaw = (await askYoutube(sents, scenes, lang)) || ytRaw;
  const yt = youtubeMeta(ytRaw, { sents, scenes, lang, countries: th.countries, channel: ch.nom || "" });
  mkdirSync("output", { recursive: true });
  writeFileSync("output/youtube-metadata.txt", `Titre: ${yt.title}\nDescription :\n${yt.description}\n`);
  writeFileSync("output/youtube.json", JSON.stringify(yt, null, 1));
  const md = [`# Faceless live arabic — plan`, ``, `## Fiche YouTube${yt.ai ? "" : " (écrite sans IA : à relire)"}`, ``, `**Titre** : ${yt.title}`, ``, "```", yt.description, "```", ``, `## Montage`, ``, `- Durée voix : ${duration.toFixed(1)} s · langue : ${lang} · format : ${formats.join(" + ")} (${base}p)`, `- Palette : **${th.code}** — ${th.why}`, `- Chaîne / logo : ${ch.why || "—"}`,
    `- Écriture : ${raw ? "IA" : "sans IA (phrases prononcées affichées telles quelles)"} `,
    `- Médias : ${imgs.length} capture(s)/photo(s) + ${okVids.length} vidéo(s) → **${placed + rest.length}/${imgs.length + broll2.length} posés en image**${imgs.some((x) => x.crop) ? ` (${imgs.filter((x) => x.crop).length} recadrés par l'IA)` : ""} · ${cuts.length} extrait(s) avec le son${opener ? " (ouverture choc comprise)" : ""}`, ...notes.map((n) => `- ${n}`), ``, `| # | début | durée | type | pays | texte |`, `|---|---|---|---|---|---|`,
    ...scenes.map((s, i) => `| ${i + 1} | ${s.t0.toFixed(1)} s | ${(s.t1 - s.t0).toFixed(1)} s | ${s.type}${s.data.media ? ` ×${s.data.media.length}` : ""}${s.offset ? " (suite)" : ""} | ${s.country || ""} | ${(s.big ? `${s.opener ? "⚡ ouverture choc" : "▶ extrait avec le son"} (${(() => { const c = cuts.find((x) => Math.abs(x.at - s.t0) < 0.01); return c?.name || path.basename(c?.file || ""); })()} ${mmss(cuts.find((c) => Math.abs(c.at - s.t0) < 0.01)?.ss || 0)})` : s.data.title || s.data.quote || s.data.label || [s.data.a, s.data.b].filter(Boolean).join(" / ") || (s.data.items || []).map((x) => x.date || x.name).join(" · ")).replace(/\|/g, "/")} |`)].join("\n");
  mkdirSync("output", { recursive: true }); writeFileSync("output/EXPLAINER.md", md + "\n");
  console.log(`✔ ${OUT} : ${scenes.length} scènes (${scenes.map((s) => s.type).join(", ")})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error("❌ " + e.message); process.exit(1); });
