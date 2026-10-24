// scripts/shorts/select.mjs — choisit les meilleurs passages d'une vidéo longue pour en faire des Shorts.
// Entrée : content/transcript.json (mots horodatés). Sortie : shorts/selection.json
//   { lang, source_duration, engine, clips:[{ id, start, end, duration, title, hook, description, hashtags, score, why }] }
// Moteur : IA (Gemini multi-clés → Groq → Claude) sur la transcription découpée en phrases numérotées ; l'IA
// répond avec des NUMÉROS de phrases (jamais des horaires inventés) ; les bornes sont ensuite calées sur les mots.
// Repli sans IA : score heuristique (densité de parole, questions, chiffres, mots-clés rares, phrases complètes).
//
// Réglages (variables d'environnement) : SHORTS_COUNT (5), SHORTS_MIN (20 s), SHORTS_MAX (60 s), SHORTS_FOCUS (consigne libre).
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { providers, parseJson, groqKeys } from "../lib/llm.mjs";

const tr = JSON.parse(readFileSync("content/transcript.json", "utf8"));
const COUNT = clampInt(process.env.SHORTS_COUNT, 5, 1, 15);
let MIN = clampInt(process.env.SHORTS_MIN, 20, 5, 170);
let MAX = clampInt(process.env.SHORTS_MAX, 60, 10, 180);
if (MAX < MIN + 5) MAX = MIN + 5;
const FOCUS = String(process.env.SHORTS_FOCUS || "").trim().slice(0, 400);
const lang = tr.lang || "fr";
const LANG_NAME = { fr: "français", ar: "arabe", en: "anglais", it: "italien" }[lang] || "français";
const DUR = tr.duration || tr.words.at(-1)?.t1 || 0;

function clampInt(v, d, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---------- phrases ----------
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ t0: cur[0].t0, t1: cur.at(-1).t1, text: cur.map((w) => w.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1"), n: cur.length });
    cur = [];
  };
  words.forEach((w, i) => {
    const gap = cur.length ? w.t0 - cur.at(-1).t1 : 0;
    if (cur.length && (gap > 0.9 || w.t1 - cur[0].t0 > 16)) flush();
    cur.push(w);
    if (/[.!?؟…]["»”]?$/.test(w.w) && cur.length >= 3) flush();
  });
  flush();
  return out.map((s, i) => ({ ...s, i }));
}
const S = sentencesOf(tr.words || []);
if (!S.length) { console.error("Aucune phrase dans la transcription : impossible de choisir des passages."); process.exit(1); }
console.log(`Vidéo ${fmt(DUR)} (${lang}), ${S.length} phrases ; objectif ${COUNT} shorts de ${MIN}-${MAX} s.`);

// ---------- normalisation d'un passage (bornes de phrases, durée) ----------
const CONNECT = /^(et|mais|donc|alors|puis|car|ou|parce|and|but|so|because|then|e|ma|quindi|perché|poi|و|ثم|لكن|لأن|ف)\b/i;
function normalizeRange(a, b) {
  a = Math.max(0, Math.min(S.length - 1, a | 0));
  b = Math.max(a, Math.min(S.length - 1, b | 0));
  const len = () => S[b].t1 - S[a].t0;
  while (len() > MAX && b > a) b--; // trop long : on retire des phrases à la fin
  while (len() > MAX && a < b) a++;
  while (len() < MIN && b < S.length - 1 && S[b + 1].t1 - S[a].t0 <= MAX) b++; // trop court : on prolonge
  while (len() < MIN && a > 0 && S[b].t1 - S[a - 1].t0 <= MAX) a--;
  return { a, b, t0: S[a].t0, t1: S[b].t1 };
}
const overlap = (x, y) => Math.max(0, Math.min(x.t1, y.t1) - Math.max(x.t0, y.t0));

// ---------- IA ----------
function sys() {
  return [
    `Tu es un monteur expert en vidéos courtes virales (YouTube Shorts, TikTok, Reels). Tu écris en ${LANG_NAME}.`,
    "Tu reçois la transcription d'une vidéo longue, découpée en phrases numérotées avec leur horaire.",
    `Choisis les ${COUNT} MEILLEURS passages pour en faire des shorts autonomes de ${MIN} à ${MAX} secondes.`,
    "Critères : une idée complète et compréhensible SANS le reste de la vidéo ; accroche forte dès la première phrase (affirmation choc, question, chiffre, révélation, émotion, conflit) ; une chute ou une conclusion nette ; pas de passage qui commence par « et / mais / donc » ou qui renvoie à « comme je disais ».",
    "Les passages ne doivent PAS se chevaucher. Varie les sujets.",
    "N'invente rien : titre, hook et description doivent refléter exactement ce qui est dit. Toute accusation visant une personne ou une institution est attribuée au locuteur (« selon lui », « il accuse »), jamais affirmée comme un fait.",
    FOCUS ? `Consigne de l'utilisateur pour le choix : ${FOCUS}` : "",
    `Réponds UNIQUEMENT en JSON : {"shorts":[{"start":<numéro de la 1re phrase>,"end":<numéro de la dernière phrase>,"score":<1-100>,"title":"titre YouTube 40-70 caractères","hook":"accroche 4-7 mots","description":"1-2 phrases","hashtags":["#...","#..."],"why":"pourquoi ce passage marche"}]} — tout en ${LANG_NAME}.`,
  ].filter(Boolean).join("\n");
}
const lines = (arr) => arr.map((s) => `[${s.i}] ${fmt(s.t0)} ${s.text.slice(0, 400)}`).join("\n");
const approxTokens = (str) => Math.ceil(str.length / 3.2);

async function viaLLM() {
  const list = providers();
  if (!list.length) return null;
  const all = lines(S);
  for (const [name, fn] of list) {
    try {
      let raw = [];
      if (name === "groq" && approxTokens(all) > 7000) {
        // offre gratuite Groq ≈ 12 000 jetons/min : on envoie la transcription par parties, avec une pause entre elles
        const parts = [];
        let cur = [], size = 0;
        for (const s of S) { const t = approxTokens(s.text) + 6; if (size + t > 6000 && cur.length) { parts.push(cur); cur = []; size = 0; } cur.push(s); size += t; }
        if (cur.length) parts.push(cur);
        const per = Math.max(2, Math.ceil((COUNT * 1.6) / parts.length));
        console.log(`Sélection via groq en ${parts.length} parties (${per} candidats par partie)...`);
        for (let k = 0; k < parts.length; k++) {
          if (k) await new Promise((r) => setTimeout(r, 62000));
          const j = parseJson(await fn(sys().replace(`les ${COUNT} MEILLEURS`, `les ${per} MEILLEURS`), lines(parts[k]), { maxTokens: 3000 }));
          raw.push(...(j?.shorts || []));
        }
      } else {
        console.log(`Sélection des passages via ${name}...`);
        const j = parseJson(await fn(sys(), all, { maxTokens: 8192, temperature: 0.4, timeoutMs: 5 * 60 * 1000 }));
        raw = j?.shorts || [];
      }
      const clips = clean(raw.map((c) => ({ ...c, start: Number(c.start), end: Number(c.end) })).filter((c) => Number.isInteger(c.start) && Number.isInteger(c.end)), true);
      if (!clips.length) throw new Error("aucun passage exploitable dans la réponse");
      return { engine: name, clips };
    } catch (e) {
      console.log(`${name} : sélection impossible (${e.message}) — essai suivant.`);
    }
  }
  return null;
}

function clean(raw, fromLLM) {
  const out = [];
  const sorted = [...raw].sort((x, y) => (Number(y.score) || 0) - (Number(x.score) || 0));
  for (const c of sorted) {
    if (c.start > c.end) [c.start, c.end] = [c.end, c.start];
    const r = normalizeRange(c.start, c.end);
    const d = r.t1 - r.t0;
    if (d < Math.min(MIN, DUR) - 3 || d > MAX + 1) continue;
    if (out.some((o) => overlap(o, r) > 0.25 * Math.min(d, o.t1 - o.t0))) continue;
    out.push({ ...r, title: str(c.title, 100), hook: str(c.hook, 80), description: str(c.description, 400), why: str(c.why, 300),
      hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).filter((h) => h.length > 2).slice(0, 6),
      score: Math.round(Number(c.score) || 0), source: fromLLM ? "ia" : "heuristique" });
    if (out.length >= COUNT) break;
  }
  return out;
}
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// ---------- repli heuristique ----------
function heuristic() {
  const norm = (w) => w.toLowerCase().normalize("NFD").replace(/[̀-ًͯ-ٟ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
  const df = new Map();
  for (const s of S) for (const w of new Set(s.text.split(/\s+/).map(norm).filter((x) => x.length >= 5))) df.set(w, (df.get(w) || 0) + 1);
  const sScore = S.map((s) => {
    const ws = s.text.split(/\s+/).map(norm).filter((x) => x.length >= 5);
    const rare = ws.reduce((n, w) => n + Math.log(1 + S.length / (df.get(w) || 1)), 0) / Math.max(4, ws.length);
    const rate = s.n / Math.max(0.5, s.t1 - s.t0); // mots/s : énergie
    return rare * 2 + (/[?؟]/.test(s.text) ? 1.5 : 0) + (/!/.test(s.text) ? 1 : 0) + (/\d/.test(s.text) ? 1 : 0) + Math.min(1.5, rate / 2.5);
  });
  const cands = [];
  for (let a = 0; a < S.length; a++) {
    if (CONNECT.test(S[a].text)) continue;
    let b = a;
    while (b < S.length - 1 && S[b + 1].t1 - S[a].t0 <= MAX) b++;
    // fin sur une phrase terminée si possible, la plus proche de ~45 s
    let best = null;
    for (let e = a; e <= b; e++) {
      const d = S[e].t1 - S[a].t0;
      if (d < MIN) continue;
      const fit = -Math.abs(d - Math.min(MAX, 45)) / 15 + (/[.!?؟]$/.test(S[e].text) ? 1 : 0);
      if (!best || fit > best.fit) best = { e, fit };
    }
    if (!best) continue;
    let sc = 0, gaps = 0;
    for (let k = a; k <= best.e; k++) { sc += sScore[k]; if (k > a) gaps += Math.max(0, S[k].t0 - S[k - 1].t1 - 0.6); }
    sc = sc / (best.e - a + 1) + best.fit * 0.5 - gaps * 0.3 + sScore[a] * 0.4; // la 1re phrase compte double (accroche)
    cands.push({ start: a, end: best.e, score: Math.round(sc * 20) });
  }
  return clean(cands, false);
}

// ---------- main ----------
let res = null;
if (DUR < MIN + 2) {
  console.log("Vidéo plus courte que la durée minimale d'un short : un seul short = toute la vidéo.");
  res = { engine: "entière", clips: [{ ...normalizeRange(0, S.length - 1), title: "", hook: "", description: "", why: "", hashtags: [], score: 50, source: "entière" }] };
} else {
  res = (await viaLLM()) || { engine: "heuristique", clips: heuristic() };
  // complète avec l'heuristique si l'IA a rendu moins de passages que demandé
  if (res.clips.length < COUNT && res.engine !== "heuristique") {
    for (const h of heuristic()) {
      if (res.clips.length >= COUNT) break;
      if (!res.clips.some((o) => overlap(o, h) > 2)) res.clips.push(h);
    }
  }
}
if (!res.clips.length) { console.error("Aucun passage trouvé."); process.exit(1); }
const clips = res.clips.slice(0, COUNT).map((c, k) => ({
  id: String(k + 1).padStart(2, "0"),
  start: +Math.max(0, c.t0 - 0.15).toFixed(3),
  end: +Math.min(DUR, c.t1 + 0.4).toFixed(3),
  ...Object.fromEntries(Object.entries(c).filter(([k]) => !["a", "b", "t0", "t1"].includes(k))),
})).map((c) => ({ ...c, duration: +(c.end - c.start).toFixed(2) }));
mkdirSync("shorts", { recursive: true });
writeFileSync("shorts/selection.json", JSON.stringify({ lang, source_duration: DUR, engine: res.engine, groq_keys: groqKeys().length, clips }, null, 2));
console.log(`Sélection (${res.engine}) :`);
clips.forEach((c) => console.log(`  #${c.id} ${fmt(c.start)}→${fmt(c.end)} (${c.duration.toFixed(0)} s) [${c.score}] ${c.title || c.hook || "(sans titre)"}`));
if (res.engine === "heuristique") console.log("⚠ Aucune IA n'a répondu : passages choisis par heuristique (titres vides). Vérifie GEMINI_API_KEY(S) / GROQ_API_KEY(S).");
