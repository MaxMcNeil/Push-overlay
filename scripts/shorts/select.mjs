// scripts/shorts/select.mjs — choisit les meilleurs passages d'une vidéo longue pour en faire des Shorts.
// Entrée : content/transcript.json (mots horodatés). Sortie : shorts/selection.json
//   { lang, source_duration, engine, clips:[{ id, start, end, duration, title, hook, description, hashtags, score, why }] }
//
// 1. PROPOSITION : l'IA lit la transcription en phrases numérotées (avec horaire ET durée de chaque phrase) et propose
//    plus de passages que demandé, chacun avec son accroche, son développement et sa chute. Elle répond par NUMÉROS de
//    phrases : les coupes tombent toujours entre deux phrases, jamais d'horaire inventé.
// 2. CONTRÔLE DES DURÉES : un passage trop court est prolongé jusqu'à la fin de l'idée (phrases suivantes), un passage
//    trop long est raccourci sur une fin de phrase. Rien n'est gardé sous la durée minimale.
// 3. JUGE : un 2e appel relit le TEXTE COMPLET de chaque passage et note s'il est compréhensible seul (sans le reste de
//    la vidéo), s'il accroche et s'il a une vraie chute. Les passages qui n'ont pas de sens seuls sont écartés.
// Mieux vaut 3 bons shorts que 5 médiocres : aucun remplissage au hasard quand l'IA fonctionne.
//
// Réglages : SHORTS_COUNT (5), SHORTS_MIN (30 s), SHORTS_MAX (90 s), SHORTS_FOCUS (consigne libre).
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { providers, parseJson } from "../lib/llm.mjs";
import { findVideo } from "../lib/util.mjs";

const ERRORS = []; // raisons des échecs IA (affichées dans le récapitulatif de la release)
// L'AUDIO est envoyé à Gemini avec la transcription : il entend le ton, l'émotion, l'ironie, l'insistance — ce qui
// fait qu'un passage « accroche » ne se lit pas toujours dans le texte. (≤ 13 Mo en 16 kb/s ≈ 1 h 50.)
function audioPart() {
  try {
    const v = findVideo();
    if (!v) return null;
    const out = "content/audio-select.mp3";
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", v, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "16k", out], { stdio: ["ignore", "ignore", "inherit"] });
    if (statSync(out).size > 13 * 1024 * 1024) { console.log("  audio trop long pour être joint : sélection sur le texte seul"); return null; }
    return { inlineData: { mimeType: "audio/mp3", data: readFileSync(out).toString("base64") } };
  } catch { return null; }
}

const tr = JSON.parse(readFileSync("content/transcript.json", "utf8"));
const COUNT = clampInt(process.env.SHORTS_COUNT, 5, 1, 15);
let MIN = clampInt(process.env.SHORTS_MIN, 30, 5, 170);
let MAX = clampInt(process.env.SHORTS_MAX, 90, 10, 180);
if (MIN < 15) { console.log(`⚠ Durée minimale ${MIN} s trop courte pour qu'un short ait du sens : 15 s utilisées.`); MIN = 15; }
if (MAX < MIN + 10) MAX = MIN + 10;
const TARGET = Math.round(Math.min(MAX, Math.max(MIN, (MIN + MAX) / 2)));
const FOCUS = String(process.env.SHORTS_FOCUS || "").trim().slice(0, 400);
const lang = tr.lang || "fr";
const LANG_NAME = { fr: "français", ar: "arabe", en: "anglais", it: "italien" }[lang] || "français";
const DUR = tr.duration || tr.words.at(-1)?.t1 || 0;

function clampInt(v, d, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const ENDS = /[.!?؟…]["»”]?$/;

// ---------- phrases ----------
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ t0: cur[0].t0, t1: cur.at(-1).t1, text: cur.map((w) => w.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1"), n: cur.length });
    cur = [];
  };
  for (const w of words) {
    const gap = cur.length ? w.t0 - cur.at(-1).t1 : 0;
    if (cur.length && (gap > 1.0 || w.t1 - cur[0].t0 > 18)) flush();
    cur.push(w);
    if (ENDS.test(w.w) && cur.length >= 3) flush();
  }
  flush();
  return out.map((s, i) => ({ ...s, i }));
}
const S = sentencesOf(tr.words || []);
if (!S.length) { console.error("Aucune phrase dans la transcription : impossible de choisir des passages."); process.exit(1); }
const punctuated = S.filter((s) => ENDS.test(s.text)).length / S.length;
console.log(`Vidéo ${fmt(DUR)} (${lang}), ${S.length} phrases (${Math.round(punctuated * 100)} % ponctuées) ; objectif ${COUNT} shorts de ${MIN}-${MAX} s (idéal ≈ ${TARGET} s).`);
const textOf = (a, b) => S.slice(a, b + 1).map((s) => s.text).join(" ");

// ---------- contrôle des bornes ----------
// trop court : on prolonge vers la FIN de l'idée (phrases suivantes), en s'arrêtant sur une fin de phrase ;
// trop long : on recule la fin jusqu'à une fin de phrase.
function fitRange(a, b) {
  a = Math.max(0, Math.min(S.length - 1, a | 0));
  b = Math.max(a, Math.min(S.length - 1, b | 0));
  const len = (x, y) => S[y].t1 - S[x].t0;
  let extended = false;
  while (len(a, b) < MIN && b < S.length - 1 && len(a, b + 1) <= MAX) { b++; extended = true; }
  // finir sur une phrase terminée si c'est possible sans dépasser MAX
  if (extended && !ENDS.test(S[b].text)) {
    let e = b;
    while (e < S.length - 1 && !ENDS.test(S[e].text) && len(a, e + 1) <= MAX) e++;
    if (ENDS.test(S[e].text)) b = e;
  }
  while (len(a, b) < MIN && a > 0 && len(a - 1, b) <= MAX) { a--; extended = true; }
  while (len(a, b) > MAX && b > a) b--;
  if (len(a, b) > MAX * 0.8) { // préfère une fin de phrase
    let e = b;
    while (e > a && !ENDS.test(S[e].text)) e--;
    if (e > a && len(a, e) >= MIN) b = e;
  }
  // toujours FINIR sur une phrase terminée (jamais sur un bout de phrase) : on recule si possible, sinon on avance
  if (!ENDS.test(S[b].text)) {
    let e = b;
    while (e > a && !ENDS.test(S[e].text)) e--;
    if (ENDS.test(S[e].text) && len(a, e) >= MIN * 0.85) b = e;
    else {
      e = b;
      while (e < S.length - 1 && !ENDS.test(S[e].text) && len(a, e + 1) <= MAX + 8) e++;
      if (ENDS.test(S[e].text)) b = e;
    }
  }
  return { a, b, t0: S[a].t0, t1: S[b].t1, extended };
}
const overlap = (x, y) => Math.max(0, Math.min(x.t1, y.t1) - Math.max(x.t0, y.t0));

// ---------- IA ----------
function proposeSys(n) {
  return [
    `Tu es un monteur expert en vidéos courtes virales (YouTube Shorts, TikTok, Reels). Tu écris en ${LANG_NAME}.`,
    "Tu reçois la transcription d'une vidéo longue en phrases numérotées : [numéro] horaire (durée de la phrase) texte.",
    `Propose les ${n} MEILLEURS passages pour en faire des shorts AUTONOMES. Durée de chaque passage : entre ${MIN} et ${MAX} secondes, idéalement ${TARGET} s.`,
    "CALCULE la durée : additionne les durées des phrases du passage. Un passage de 2 ou 3 phrases fait souvent moins de 15 s : c'est TROP COURT.",
    "OBJECTIF : des shorts VIRAUX, qu'on regarde jusqu'au bout et qu'on partage. Ce qui marche : une révélation ou un chiffre choquant, une injustice concrète, une histoire vraie avec un personnage, une prise de position tranchée, une émotion forte (colère, indignation, surprise, rire), une phrase-choc mémorable, un « vous ne saviez pas que… ».",
    "COMPRENDS LE SENS : lis (et écoute, si l'audio est joint) la vidéo entière d'abord ; identifie les messages clés et les moments où le locuteur est le plus intense. Choisis les passages qui portent ces messages, pas des transitions ou des répétitions.",
    "Chaque passage doit raconter une idée COMPLÈTE, compréhensible par quelqu'un qui n'a PAS vu le reste de la vidéo :",
    "  1) ACCROCHE : la 1re phrase capte l'attention seule (affirmation forte, question, chiffre, fait choquant, histoire) ;",
    "  2) DÉVELOPPEMENT : l'explication, l'exemple ou l'argument ;",
    "  3) CHUTE : une conclusion nette (verdict, révélation, punchline, question finale). Jamais coupé au milieu d'un raisonnement.",
    "INTERDIT : commencer par « et / mais / donc / alors / du coup / parce que », ou par un pronom sans antécédent (« il », « ça », « cette affaire ») dont on ne sait pas de qui/quoi il parle ; renvoyer à « comme je disais / tout à l'heure ».",
    "Les passages ne se chevauchent pas. Varie les sujets.",
    "N'invente rien : titre, hook et description reflètent exactement ce qui est dit. Toute accusation visant une personne ou une institution est attribuée au locuteur (« selon lui », « il accuse »), jamais affirmée comme un fait.",
    FOCUS ? `Consigne de l'utilisateur pour le choix : ${FOCUS}` : "",
    `Réponds UNIQUEMENT en JSON : {"shorts":[{"start":<n° 1re phrase>,"end":<n° dernière phrase>,"duration_s":<durée calculée>,"hook_sentence":<n°>,"payoff_sentence":<n°>,"score":<1-100>,"title":"titre YouTube 40-70 caractères","hook":"accroche 4-7 mots","description":"1-2 phrases","hashtags":["#...","#..."],"why":"en une phrase : l'idée racontée et sa chute"}]} — tout en ${LANG_NAME}.`,
  ].filter(Boolean).join("\n");
}
const lines = (arr) => arr.map((s) => `[${s.i}] ${fmt(s.t0)} (${Math.max(1, Math.round(s.t1 - s.t0))}s) ${s.text.slice(0, 500)}`).join("\n");
const approxTokens = (x) => Math.ceil(x.length / 3.2);

async function propose(name, fn) {
  const want = COUNT + 3;
  const all = lines(S);
  if (name === "groq" && approxTokens(all) > 7000) {
    // offre gratuite Groq ≈ 12 000 jetons/min : transcription envoyée par parties, avec une pause entre elles
    const parts = [];
    let cur = [], size = 0;
    for (const s of S) { const t = approxTokens(s.text) + 8; if (size + t > 6000 && cur.length) { parts.push(cur); cur = []; size = 0; } cur.push(s); size += t; }
    if (cur.length) parts.push(cur);
    const per = Math.max(2, Math.ceil(want / parts.length));
    console.log(`Propositions via groq en ${parts.length} parties (${per} par partie)...`);
    const raw = [];
    for (let k = 0; k < parts.length; k++) {
      if (k) await new Promise((r) => setTimeout(r, 62000));
      raw.push(...(parseJson(await fn(proposeSys(per), lines(parts[k]), { maxTokens: 3000, temperature: 0.4 }))?.shorts || []));
    }
    return raw;
  }
  const audio = name === "gemini" ? audioPart() : null;
  console.log(`Propositions de passages via ${name}${audio ? " (transcription + audio)" : ""}...`);
  const txt = await fn(proposeSys(want), (audio ? "L'AUDIO de la vidéo est joint : écoute le ton et l'intensité du locuteur.\n\n" : "") + all, { audio, maxTokens: 24000, temperature: 0.4, timeoutMs: 6 * 60 * 1000 });
  const j = parseJson(txt);
  if (!j) throw new Error(`réponse illisible (début : ${String(txt).replace(/\s+/g, " ").slice(0, 160)})`);
  return j.shorts || [];
}

function judgeSys() {
  return [
    `Tu es rédacteur en chef de vidéos courtes. Tu évalues des extraits candidats à devenir des shorts autonomes. Réponds en ${LANG_NAME} pour les textes.`,
    "Pour CHAQUE extrait (texte intégral fourni), note de 0 à 10 :",
    "- autonome : un spectateur qui n'a PAS vu la vidéo complète comprend de quoi on parle et de qui (pas de pronom ou de référence sans contexte) ;",
    "- accroche : la première phrase donne envie de rester ;",
    "- chute : l'extrait se termine sur une conclusion nette, pas au milieu d'une idée ;",
    "- interet : potentiel VIRAL — sujet fort, émotion, révélation, phrase-choc, envie de partager ou de commenter.",
    "Sois SÉVÈRE : un extrait qui commence ou finit au milieu d'un raisonnement a autonome ≤ 4 ou chute ≤ 4.",
    "Tu peux proposer un meilleur titre (40-70 caractères) et un meilleur hook (4-7 mots), fidèles au texte, accusations attribuées au locuteur.",
    'Réponds UNIQUEMENT en JSON : {"verdicts":[{"id":"<id>","autonome":0,"accroche":0,"chute":0,"interet":0,"title":"...","hook":"...","probleme":"court, si note basse"}]}',
  ].join("\n");
}
async function judge(fn, cands) {
  const user = cands.map((c) => `=== id ${c.key} (${Math.round(c.t1 - c.t0)} s) ===\n${textOf(c.a, c.b).slice(0, 2500)}`).join("\n\n");
  const j = parseJson(await fn(judgeSys(), user, { maxTokens: 16000, temperature: 0.2, timeoutMs: 4 * 60 * 1000 }));
  const map = new Map();
  for (const v of j?.verdicts || []) map.set(String(v.id), v);
  return map;
}

function toCandidates(raw, source) {
  const out = [];
  raw.forEach((c, k) => {
    let s0 = Number(c.start), s1 = Number(c.end);
    if (!Number.isInteger(s0) || !Number.isInteger(s1)) return;
    if (s0 > s1) [s0, s1] = [s1, s0];
    const r = fitRange(s0, s1);
    const d = r.t1 - r.t0;
    if (d < Math.min(MIN, DUR) - 2 || d > MAX + 2) return;
    out.push({ ...r, key: `c${k + 1}`, title: str(c.title, 100), hook: str(c.hook, 80), description: str(c.description, 400), why: str(c.why, 300),
      hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).filter((h) => h.length > 2).slice(0, 6),
      score: Math.round(Number(c.score) || 0), source });
  });
  return out;
}
function pickNonOverlapping(cands, n) {
  const out = [];
  for (const c of [...cands].sort((x, y) => y.score - x.score)) {
    const d = c.t1 - c.t0;
    if (out.some((o) => overlap(o, c) > 0.2 * Math.min(d, o.t1 - o.t0))) continue;
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

async function viaLLM() {
  for (const [name, fn] of providers()) {
    try {
      const raw = await propose(name, fn);
      let cands = toCandidates(raw, "ia");
      const ext = cands.filter((c) => c.extended).length;
      console.log(`  ${raw.length} propositions, ${cands.length} gardées après contrôle des durées${ext ? ` (${ext} prolongée(s) jusqu'à la fin de l'idée)` : ""}.`);
      if (!cands.length) throw new Error("aucun passage exploitable dans la réponse");
      cands = pickNonOverlapping(cands, COUNT + 3);
      // juge : relit le texte complet de chaque passage
      try {
        const v = await judge(fn, cands);
        if (v.size) {
          cands = cands.map((c) => {
            const x = v.get(c.key);
            if (!x) return { ...c, judged: false };
            const n = (k) => Math.max(0, Math.min(10, Number(x[k]) || 0));
            const q = { autonome: n("autonome"), accroche: n("accroche"), chute: n("chute"), interet: n("interet") };
            return { ...c, judged: true, q, probleme: str(x.probleme, 200),
              title: str(x.title, 100) || c.title, hook: str(x.hook, 80) || c.hook,
              score: Math.round(q.autonome * 2.5 + q.chute * 2 + q.accroche * 2.5 + q.interet * 3) };
          });
          const rejected = cands.filter((c) => c.judged && (c.q.autonome < 6 || c.q.chute < 5));
          rejected.forEach((c) => console.log(`  ✘ écarté ${fmt(c.t0)}→${fmt(c.t1)} « ${c.title} » : autonome ${c.q.autonome}/10, chute ${c.q.chute}/10${c.probleme ? ` — ${c.probleme}` : ""}`));
          const kept = cands.filter((c) => !rejected.includes(c));
          if (kept.length) cands = kept;
          else console.log("  ⚠ le juge a tout écarté : on garde les meilleurs malgré tout.");
        }
      } catch (e) { console.log(`  juge indisponible (${e.message}) : sélection sans relecture.`); ERRORS.push(`juge ${name} : ${e.message}`.slice(0, 300)); }
      return { engine: name, clips: pickNonOverlapping(cands, COUNT) };
    } catch (e) {
      console.log(`${name} : sélection impossible (${e.message}) — essai suivant.`);
      ERRORS.push(`${name} : ${e.message}`.slice(0, 300));
    }
  }
  return null;
}

// ---------- repli sans IA ----------
const CONNECT = /^(et|mais|donc|alors|puis|car|ou|parce|du coup|and|but|so|because|then|e|ma|quindi|perché|poi|و|ثم|لكن|لأن|ف)\b/i;
function heuristic() {
  const norm = (w) => w.toLowerCase().normalize("NFD").replace(/[̀-ًͯ-ٟ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
  const df = new Map();
  for (const s of S) for (const w of new Set(s.text.split(/\s+/).map(norm).filter((x) => x.length >= 5))) df.set(w, (df.get(w) || 0) + 1);
  const sScore = S.map((s) => {
    const ws = s.text.split(/\s+/).map(norm).filter((x) => x.length >= 5);
    const rare = ws.reduce((n, w) => n + Math.log(1 + S.length / (df.get(w) || 1)), 0) / Math.max(4, ws.length);
    const rate = s.n / Math.max(0.5, s.t1 - s.t0);
    return rare * 2 + (/[?؟]/.test(s.text) ? 1.5 : 0) + (/!/.test(s.text) ? 1 : 0) + (/\d/.test(s.text) ? 1 : 0) + Math.min(1.5, rate / 2.5);
  });
  const cands = [];
  for (let a = 0; a < S.length; a++) {
    if (CONNECT.test(S[a].text)) continue;
    let best = null;
    for (let e = a; e < S.length && S[e].t1 - S[a].t0 <= MAX; e++) {
      const d = S[e].t1 - S[a].t0;
      if (d < MIN) continue;
      const fit = -Math.abs(d - TARGET) / 15 + (ENDS.test(S[e].text) ? 1 : 0);
      if (!best || fit > best.fit) best = { e, fit };
    }
    if (!best) continue;
    let sc = 0, gaps = 0;
    for (let k = a; k <= best.e; k++) { sc += sScore[k]; if (k > a) gaps += Math.max(0, S[k].t0 - S[k - 1].t1 - 0.6); }
    sc = sc / (best.e - a + 1) + best.fit * 0.5 - gaps * 0.3 + sScore[a] * 0.4;
    cands.push({ start: a, end: best.e, score: Math.round(sc * 20) });
  }
  return pickNonOverlapping(toCandidates(cands, "heuristique"), COUNT);
}

// ---------- main ----------
let res;
if (DUR < MIN + 2) {
  console.log("Vidéo plus courte que la durée minimale d'un short : un seul short = toute la vidéo.");
  res = { engine: "entière", clips: [{ ...fitRange(0, S.length - 1), title: "", hook: "", description: "", why: "", hashtags: [], score: 50, source: "entière" }] };
} else {
  res = (await viaLLM()) || { engine: "heuristique", clips: heuristic() };
}
if (!res.clips.length) { console.error(`Aucun passage de ${MIN}-${MAX} s trouvé. Essaie une durée minimale plus courte ou une durée maximale plus longue.`); process.exit(1); }
if (res.clips.length < COUNT) console.log(`ℹ ${res.clips.length} short(s) au lieu de ${COUNT} : seuls ces passages tiennent debout seuls (mieux vaut moins mais bons).`);
// bornes de coupe : une petite marge, mais JAMAIS jusqu'au premier mot de la phrase suivante (ni depuis le dernier
// mot de la précédente) — sinon le short finit sur une syllabe amputée.
const wordsAll = tr.words || [];
function cutBounds(t0, t1) {
  const prev = [...wordsAll].reverse().find((w) => w.t1 <= t0 + 0.01 && w.t0 < t0 - 0.01);
  const next = wordsAll.find((w) => w.t0 >= t1 - 0.01 && w.t1 > t1 + 0.01);
  const start = Math.max(0, t0 - 0.15, prev ? prev.t1 + 0.04 : 0);
  let end = Math.min(DUR, t1 + 0.4);
  if (next) end = Math.min(end, Math.max(t1 + 0.04, next.t0 - 0.1));
  return { start: +Math.min(start, t0).toFixed(3), end: +Math.max(end, t1).toFixed(3) };
}
const clips = res.clips.map((c, k) => ({
  id: String(k + 1).padStart(2, "0"),
  ...cutBounds(c.t0, c.t1),
  title: c.title, hook: c.hook, description: c.description, hashtags: c.hashtags, why: c.why,
  score: c.score, source: c.source, quality: c.q || null, text: textOf(c.a, c.b).slice(0, 3000),
})).map((c) => ({ ...c, duration: +(c.end - c.start).toFixed(2) }));
mkdirSync("shorts", { recursive: true });
writeFileSync("shorts/selection.json", JSON.stringify({ lang, source_duration: DUR, engine: res.engine, min: MIN, max: MAX, errors: ERRORS, clips }, null, 2));
console.log(`Sélection (${res.engine}) :`);
clips.forEach((c) => console.log(`  #${c.id} ${fmt(c.start)}→${fmt(c.end)} (${c.duration.toFixed(0)} s) [${c.score}] ${c.title || c.hook || "(sans titre)"}${c.quality ? `  — autonome ${c.quality.autonome}, chute ${c.quality.chute}` : ""}\n      « ${c.text.slice(0, 160)}… »`));
if (res.engine === "heuristique") console.log("⚠ Aucune IA n'a répondu : passages choisis par heuristique (titres vides). Vérifie GEMINI_API_KEY(S) / GROQ_API_KEY(S).");
