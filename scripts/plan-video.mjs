// scripts/plan-video.mjs
// Écrit content/plan.json : le "scénario" du montage (hook, headlines, cartes
// d'analyse = valeur ajoutée, emojis), calé sur les horaires de la vidéo.
//
// Moteur d'écriture, par ordre de préférence :
//   1. Claude (API Anthropic) si le secret ANTHROPIC_API_KEY existe -> meilleure qualité, ~10 s.
//   2. LLM local (llama.cpp + Qwen2.5-7B, installé par le workflow) -> gratuit, ~10 min.
//   3. Repli heuristique (phrases propres du transcript) -> toujours disponible, moins "waaaw".
// Chaque headline est validée (phrase complète, bonne longueur, ancrée dans le
// contenu). Celles qui échouent sont régénérées puis remplacées par le repli.
// Les 3 disclaimers de protection restent TOUJOURS en tête (ticker permanent + 1er items).

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { spawn, execFileSync } from "child_process";
import { cpus } from "os";
import { CONTENT_DIR, wordCount, findVideo } from "./lib/util.mjs";

const TR = `${CONTENT_DIR}/transcript.json`;
const OUT = `${CONTENT_DIR}/plan.json`;
const MANUAL = `${CONTENT_DIR}/manual-headlines.txt`;

export const DISCLAIMERS = {
  fr: [
    "Clause de non-responsabilité : les informations proposées ne constituent pas des vérités définitives et peuvent comporter des inexactitudes. Chaque utilisateur est invité à procéder à ses propres vérifications",
    "Mes propos reflètent mon opinion et ne constituent pas une vérité absolue. À chacun de vérifier et de croiser les sources",
    "Exercé au titre de la liberté d'expression (Art. 19 DUDH), ce contenu informatif peut comporter des erreurs. Il appartient à chacun de croiser et vérifier les sources",
  ],
  ar: [
    "إخلاء مسؤولية: المعلومات المقدمة لا تشكل حقائق نهائية وقد تحتوي على أخطاء. كل مستخدم مدعو للتحقق بنفسه من المعلومات",
    "آرائي تعكس وجهة نظري الشخصية ولا تشكل حقيقة مطلقة. لكل شخص أن يتحقق من المصادر ويقارن بينها",
    "يُقدَّم هذا المحتوى الإعلامي في إطار حرية التعبير (المادة 19 من الإعلان العالمي لحقوق الإنسان)، وقد يتضمن أخطاء. يتوجب على كل شخص التحقق من المصادر ومقارنتها",
  ],
  en: [
    "Disclaimer: the information provided is not definitive truth and may contain inaccuracies. Everyone is invited to do their own verification",
    "My words reflect my opinion and are not an absolute truth. It is up to each person to verify and cross-check sources",
    "Published under freedom of expression (Art. 19 UDHR), this informational content may contain errors. Everyone should cross-check and verify the sources",
  ],
  it: [
    "Esclusione di responsabilità: le informazioni fornite non costituiscono verità definitive e possono contenere inesattezze. Ognuno è invitato a effettuare le proprie verifiche",
    "Le mie parole riflettono la mia opinione e non sono una verità assoluta. Ciascuno verifichi e incroci le fonti",
    "Diffuso in virtù della libertà di espressione (Art. 19 DUDU), questo contenuto informativo può contenere errori. Spetta a ciascuno incrociare e verificare le fonti",
  ],
};

const LANG_NAME = { fr: "français", ar: "arabe (العربية, écriture arabe)", en: "anglais", it: "italien" };
const KICKERS = {
  fr: ["POURQUOI ?", "LE CONTEXTE", "COMMENT ÇA MARCHE", "À RETENIR", "L'ANGLE MORT", "CE QUE ÇA CHANGE"],
  ar: ["لماذا؟", "السياق", "كيف يحدث ذلك؟", "الخلاصة", "الزاوية المخفية", "ماذا يغيّر هذا؟"],
  en: ["WHY IT MATTERS", "THE CONTEXT", "HOW IT WORKS", "KEY TAKEAWAY", "THE BLIND SPOT", "WHAT CHANGES"],
  it: ["PERCHÉ CONTA", "IL CONTESTO", "COME FUNZIONA", "DA RICORDARE", "L'ANGOLO CIECO", "COSA CAMBIA"],
};
const EMOJIS = ["🔥", "⚡", "👀", "💥", "🧠", "⚠️", "🎯", "🚨", "💡", "📈"];

// ---------- validation d'une headline : phrase complète, pas du charabia ----------
const DANGLING = {
  fr: /\b(et|ou|mais|donc|car|que|qui|de|du|des|le|la|les|un|une|à|au|aux|pour|par|sur|dans|avec|sans|ce|cette|son|sa|ses|leur|en|d'|l')$/i,
  en: /\b(and|or|but|the|a|an|of|to|in|on|for|with|that|which|his|her|their|its|is|are)$/i,
  it: /\b(e|o|ma|il|lo|la|i|gli|le|un|una|di|a|da|in|con|su|per|che|del|della|dei)$/i,
  ar: /(^|\s)(و|في|من|إلى|على|عن|مع|أن|إن|التي|الذي)$/,
};
export function isCleanHeadline(h, lang) {
  if (!h) return false;
  const t = h.trim();
  const n = wordCount(t);
  if (n < 4 || n > 13) return false;
  if (/\.{2,}|…$/.test(t)) return false;
  if (/[{}\[\]<>_*#]/.test(t)) return false;
  if ((DANGLING[lang] || DANGLING.fr).test(t.replace(/[?!.،؟]+$/, ""))) return false;
  const ws = t.toLowerCase().split(/\s+/);
  if (new Set(ws).size < ws.length * 0.7) return false; // répétitions
  if (lang !== "ar" && /^[a-zà-ÿ]/.test(t)) return false; // doit commencer par une majuscule
  if (lang !== "ar" && /[a-zà-ÿ]{3,}[A-Z]/.test(t)) return false; // mots collés
  if (lang === "ar" && /[A-Za-z]{6,}/.test(t)) return false; // mélange de langues incohérent
  return true;
}

// Une carte ne doit contenir QUE la langue de la vidéo (pas d'anglais dans une carte arabe, etc.)
const GARBAGE = /[\uFFFD\uE000-\uF8FF\u2580-\u25FF\u200B-\u200D\uFEFF]/;
export function foreignScript(t, lang) {
  if (!t) return false;
  if (GARBAGE.test(t)) return true;
  if (lang === "ar") return /[A-Za-z\u00C0-\u00FF]{2,}/.test(t); // latin dans une carte arabe
  return /[\u0600-\u06FF]/.test(t); // arabe dans une carte FR/EN/IT
}
export function isCleanCardText(t, lang) {
  if (!t) return false;
  const n = wordCount(t);
  if (n < 8 || n > 48) return false;
  if (foreignScript(t, lang)) return false;
  if (/\.{2,}|…/.test(t)) return false;
  return true;
}
export function isCleanPoint(p, lang) {
  if (typeof p !== "string") return false;
  const n = wordCount(p);
  if (n < 3 || n > 14) return false;
  if (foreignScript(p, lang) || /\.{2,}|…/.test(p)) return false;
  return true;
}
function pointsOk(j, lang) {
  return j && Array.isArray(j.points) && j.points.length >= 2 && j.points.length <= 4 && j.points.every((x) => isCleanPoint(x, lang));
}
function cardOk(j, lang) {
  return j && (pointsOk(j, lang) || isCleanCardText(j.text, lang)) && !foreignScript(j.title, lang) && !foreignScript(j.kicker, lang);
}

function keywords(text) {
  return new Set(
    text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N} ]/gu, " ").split(" ").filter((w) => w.length >= 4)
  );
}
function grounded(h, kw) {
  const w = h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").split(" ").filter((x) => x.length >= 4);
  return w.length === 0 || w.some((x) => kw.has(x));
}

// ---------- découpage du transcript en beats horodatés ----------
function makeChunks(words, duration) {
  const n = Math.max(3, Math.min(14, Math.round(duration / 9)));
  const total = duration || words[words.length - 1].t1;
  const target = total / n;
  const chunks = [];
  let cur = { t0: 0, words: [] };
  for (const w of words) {
    cur.words.push(w);
    const span = w.t1 - cur.t0;
    const endsSentence = /[.!?؟…]$/.test(w.w);
    if ((span >= target && endsSentence) || span >= target * 1.6) {
      cur.t1 = w.t1;
      chunks.push(cur);
      cur = { t0: w.t1, words: [] };
    }
  }
  if (cur.words.length) {
    cur.t1 = Math.max(total, cur.words[cur.words.length - 1].t1);
    if (chunks.length && cur.t1 - cur.t0 < target * 0.5) {
      const last = chunks[chunks.length - 1];
      last.words.push(...cur.words);
      last.t1 = cur.t1;
    } else chunks.push(cur);
  }
  chunks[0].t0 = 0;
  chunks[chunks.length - 1].t1 = total;
  for (const c of chunks) c.text = c.words.map((x) => x.w).join(" ").replace(/\s+/g, " ").trim();
  return chunks;
}

// ---------- prompts ----------
function systemPrompt(lang) {
  return [
    `Tu es un monteur-rédacteur senior pour vidéos d'actualité courtes (Reels, Shorts, TikTok, YouTube). Tu écris en ${LANG_NAME[lang]}.`,
    "",
    "OBJECTIF : apporter une VALEUR AJOUTÉE à la vidéo (explication, contexte, mise en perspective, ironie maîtrisée) et maximiser la rétention.",
    "",
    "RÈGLES DES HEADLINES (strictes) :",
    "- Une PHRASE COMPLÈTE et grammaticalement correcte : sujet + verbe, de 5 à 11 mots. Jamais de fragment, jamais coupée en plein milieu, jamais finie par un article ou une préposition.",
    "- Choc mais honnête : contraste, enjeu, chiffre, conséquence concrète ou question qui pique. Pas de clickbait mensonger.",
    "- Elle doit parler PRÉCISÉMENT de ce qui est dit dans l'extrait (personnes, chiffres, idées). Hors-sujet = échec.",
    "- N'invente AUCUN chiffre, nom, citation ou fait absent de l'extrait.",
    "- Personnes réelles : chaque affirmation (headline ET carte) doit être directement déductible de l'extrait. N'attribue jamais à une personne nommée une intention, une identité, une orientation, un acte ou une déclaration qu'elle n'a pas clairement exprimés dans l'extrait. En cas de doute, reformule en restant au plus près des mots prononcés.",
    "- ATTRIBUTION : le locuteur est la personne qui parle dans la vidéo ; ne le confonds JAMAIS avec les personnes qu'il cite, interpelle ou dont il parle. Toute affirmation, vision, prédiction ou accusation du locuteur est présentée COMME SA PAROLE (« il affirme », « selon lui », « il dit avoir vu », « il défie… »), jamais comme un fait établi, surtout quand elle concerne des personnes réelles, une autorité ou la religion.",
    "- Si la transcription semble contenir une erreur de reconnaissance (nom propre douteux), évite ce nom plutôt que de le deviner.",
    "- VARIÉTÉ : ne commence pas deux headlines consécutives par le même mot (surtout pas « Le locuteur / Il / المتحدث » à chaque fois). Alterne : un fait concret, une question, un verbe d'action, un contraste, le sujet traité. L'attribution se glisse ailleurs dans la phrase (« selon lui », « يقول », « بحسب كلامه »).",
    "- Pas de \"je\". Pas d'hésitation orale. Varier les formes d'un extrait à l'autre (affirmation, question, contraste).",
    "",
    "RÈGLES DE LA CARTE D'ANALYSE (valeur ajoutée) :",
    "- kicker : 1 à 3 mots (ex. POURQUOI ?, LE CONTEXTE, COMMENT ÇA MARCHE).",
    "- title : 3 à 8 mots, une idée forte.",
    "- points : EXACTEMENT 3 points courts (5 à 9 mots chacun), phrases complètes et propres. Ils apportent la VALEUR AJOUTÉE : le POURQUOI, le COMMENT ou un éclairage de contexte général et vérifiable. Ce n'est NI un résumé NI une citation de la parole (jamais de phrase brisée de la transcription). Jamais de fait nouveau sur une personne nommée. Pas de chiffres absents de l'extrait.",
    "- emoji : UN seul emoji pertinent.",
    "",
    `LANGUE : TOUS les champs (headline, kicker, title, points) doivent être écrits EXCLUSIVEMENT en ${LANG_NAME[lang]}. Pas un seul mot d'une autre langue, aucun mot anglais, aucun caractère étrange.`,
    "TRANSCRIPTION BRUITÉE : le texte fourni vient d'une reconnaissance vocale automatique qui se trompe beaucoup (dialecte, noms propres, mots inventés). Ne recopie JAMAIS ses phrases brisées : comprends le SENS GLOBAL (écoute l'audio s'il est joint) et reformule proprement.",
    lang === "ar" ? "اكتب جميع الحقول بالعربية الفصحى المبسطة (لغة الإعلام) حتى لو كان المتحدث يتكلم بلهجة خليجية: أعد صياغة المعنى بفصحى سليمة، ولا تنقل كلمات اللهجة كما هي، ولا تكتب كلمات لا معنى لها، ولا أي كلمة إنجليزية أو فرنسية، وبجمل كاملة وصحيحة نحويا." : "",
  ].filter((x) => x !== "").join("\n");
}

function chunkUser(lang, chunk, i, n, prevHeadlines) {
  return [
    `Extrait ${i + 1}/${n} de la vidéo :`,
    `"""${chunk.text.slice(0, 1400)}"""`,
    prevHeadlines.length ? `Headlines déjà utilisées (ne pas répéter l'angle) : ${prevHeadlines.slice(-4).join(" | ")}` : "",
    `Réponds UNIQUEMENT par un objet JSON : {"headline":"...","emoji":"...","kicker":"...","title":"...","points":["...","...","..."]} en ${LANG_NAME[lang]}.`,
  ].filter(Boolean).join("\n");
}

function hookUser(lang, headlines) {
  return [
    "Voici les headlines de la vidéo :",
    headlines.map((h, i) => `${i + 1}. ${h}`).join("\n"),
    `Écris le HOOK d'ouverture (affiché 3 secondes avant tout le reste) en ${LANG_NAME[lang]} : UNE question percutante ou UNE affirmation choc de 5 à 10 mots, phrase complète, qui donne envie de rester jusqu'au bout et reste vraie par rapport au contenu.`,
    'Réponds UNIQUEMENT par un objet JSON : {"hook":"...","emoji":"..."}',
  ].join("\n");
}

function parseJson(raw) {
  if (!raw) return null;
  const m = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- moteur 1 : IA en ligne (GRATUITES : Gemini, Groq ; optionnelle payante : Claude) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // tashkeel + tatweel : illisibles en sous-titre
export const tidy = (t, lang) => {
  if (typeof t !== "string") return t;
  let o = t.replace(/\s+/g, " ").replace(/^["«“'\s]+|["»”'\s]+$/g, "").trim();
  if (lang === "ar") o = o.replace(DIACRITICS, "");
  return o;
};

const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";
async function callGemini(sys, user, ctx = {}) {
  const key = process.env.GEMINI_API_KEY;
  const H = { "content-type": "application/json", "x-goog-api-key": key };
  let candidates = [];
  if (process.env.GEMINI_MODEL) candidates = [process.env.GEMINI_MODEL];
  else {
    // "gemini-flash-latest" suit automatiquement le dernier modèle Flash ; on garde en secours les Flash trouvés
    // via l'API (les modèles anciens sont retirés régulièrement, on ne code donc aucun nom en dur).
    candidates = ["gemini-flash-latest"];
    try {
      const r = await fetch(`${GEMINI_BASE}/v1beta/models?pageSize=200`, { headers: H });
      if (r.ok) {
        const found = ((await r.json()).models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""))
          .filter((n) => /flash/.test(n) && !/(lite|image|tts|live|audio|embedding|robotics|computer|thinking-exp)/.test(n))
          .sort((x, y) => {
            const vx = parseFloat((x.match(/(\d+(?:\.\d+)?)/) || [0])[0]), vy = parseFloat((y.match(/(\d+(?:\.\d+)?)/) || [0])[0]);
            return vy - vx || (/preview/.test(x) ? 1 : 0) - (/preview/.test(y) ? 1 : 0);
          });
        candidates.push(...found.slice(0, 4));
      }
    } catch {}
  }
  let lastErr = new Error("aucun modèle Gemini disponible");
  for (const m of [...new Set(candidates)]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${GEMINI_BASE}/v1beta/models/${m}:generateContent`, {
          method: "POST", headers: H,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: [{ role: "user", parts: [...(ctx.audio ? [ctx.audio] : []), { text: user }] }],
            generationConfig: { temperature: 0.7, responseMimeType: "application/json", maxOutputTokens: 8192 },
          }),
          signal: AbortSignal.timeout(3 * 60 * 1000),
        });
        if (res.status === 429 || res.status === 503) { console.log(`  Gemini ${m} : saturé (${res.status}), pause...`); await sleep(20000 * (attempt + 1)); continue; }
        if (!res.ok) {
          const body = (await res.text()).replace(/\s+/g, " ").slice(0, 700);
          const hint = res.status === 403 || res.status === 400
            ? " → CLÉ REFUSÉE (clé restreinte à d'autres API, API non activée, ou clé invalide). Crée une NOUVELLE clé sur https://aistudio.google.com/apikey (« Create API key in new project », sans aucune restriction) puis remets le secret GEMINI_API_KEY."
            : "";
          throw new Error(`Gemini ${m} : HTTP ${res.status} ${body}${hint}`);
        }
        const d = await res.json();
        const txt = (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
        if (!txt) throw new Error(`Gemini ${m} : réponse vide`);
        console.log(`  Gemini : modèle utilisé = ${m}`);
        return txt;
      } catch (e) { lastErr = e; console.log(`  ${e.message}`); break; }
    }
  }
  throw lastErr;
}

async function callGroq(sys, user, ctx = {}) {
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${GROQ_BASE}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model, temperature: 0.6, max_tokens: 4096, response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(3 * 60 * 1000),
    });
    if (res.status === 429) {
      const wait = Math.min(60, Number(res.headers.get("retry-after")) || 15 * (attempt + 1));
      console.log(`  Groq : limite atteinte, pause ${wait}s...`);
      await sleep(wait * 1000);
      lastErr = new Error("Groq : limite de débit (429)");
      continue;
    }
    if (!res.ok) throw new Error(`Groq ${model} : HTTP ${res.status} ${(await res.text()).slice(0, 180)}`);
    const d = await res.json();
    console.log(`  Groq : modèle utilisé = ${model}`);
    return d.choices?.[0]?.message?.content || "";
  }
  throw lastErr;
}

async function callClaude(sys, user, ctx = {}) {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const res = await fetch(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 6000, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude : HTTP ${res.status} ${(await res.text()).slice(0, 180)}`);
  const data = await res.json();
  return data.content.map((c) => c.text || "").join("");
}

function audioPart() {
  const v = findVideo();
  if (!v) return null;
  try {
    const out = `${CONTENT_DIR}/audio-gemini.mp3`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", v, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out], { stdio: ["ignore", "ignore", "ignore"] });
    if (statSync(out).size > 14 * 1024 * 1024) return null; // limite de la requête inline
    return { inlineData: { mimeType: "audio/mp3", data: readFileSync(out).toString("base64") } };
  } catch { return null; }
}

// Un seul appel avec TOUTE la vidéo : le modèle comprend l'histoire d'ensemble (bien meilleur qu'extrait par extrait).
async function viaApi(chunks, lang) {
  const providers = [
    ["gemini", process.env.GEMINI_API_KEY, callGemini],
    ["groq", process.env.GROQ_API_KEY, callGroq],
    ["claude", process.env.ANTHROPIC_API_KEY, callClaude],
  ].filter((x) => x[1]);
  if (!providers.length) return null;
  const sys = systemPrompt(lang);
  const audio = providers.some((x) => x[0] === "gemini") ? audioPart() : null;
  const user = [
    "Voici la vidéo découpée en extraits horodatés (transcription automatique BRUITÉE : elle contient des erreurs de reconnaissance, surtout en dialecte) :",
    chunks.map((c, i) => `[#${i + 1}] (${c.t0.toFixed(0)}s-${c.t1.toFixed(0)}s) ${c.text.slice(0, 1400)}`).join("\n\n"),
    "",
    audio ? "L'AUDIO ORIGINAL de la vidéo est joint : en cas de divergence avec la transcription, fie-toi à l'AUDIO." : "",
    `Étape 1 : comprends de quoi parle la vidéo dans son ensemble (champ "summary" : 2 phrases fidèles, en ${LANG_NAME[lang]}).`,
    `Étape 2 : produis le scénario. Réponds UNIQUEMENT par un objet JSON : {"summary":"...","hook":"...","hook_emoji":"...","keywords":["..."],"beats":[{"headline":"...","emoji":"...","kicker":"...","title":"...","points":["...","...","..."]}]} avec EXACTEMENT ${chunks.length} beats (un par extrait, dans l'ordre), tout en ${LANG_NAME[lang]}. Le hook est une question percutante ou une affirmation choc de 5 à 10 mots. "keywords" : 12 à 25 mots-clés IMPORTANTS, recopiés EXACTEMENT comme ils apparaissent dans la transcription ci-dessus (même graphie), utilisés pour les faire apparaître à l'écran quand le locuteur les prononce.`,
  ].filter(Boolean).join("\n");
  for (const [name, , fn] of providers) {
    try {
      console.log(`Écriture du scénario via ${name}...`);
      const j = parseJson(await fn(sys, user, { audio }));
      if (!j || !Array.isArray(j.beats)) throw new Error("JSON inattendu");
      if (j.summary) console.log(`  Résumé compris par l'IA : ${String(j.summary).slice(0, 220)}`);
      return { engine: name, hook: j.hook, hookEmoji: j.hook_emoji, beats: j.beats, keywords: j.keywords };
    } catch (e) {
      console.log(`${name} indisponible (${e.message}) — essai suivant.`);
    }
  }
  return null;
}

// ---------- moteur 2 : llama.cpp local ----------
const LLAMA_BIN = "llama.cpp/build/bin/llama-server";
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama.cpp/models/qwen2.5-7b-instruct-q4_k_m.gguf";
const PORT = 8811;
const BASE = process.env.LLAMA_URL || `http://127.0.0.1:${PORT}`;

async function waitReady(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function chatLocal(system, user, maxTokens = 450) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens, temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(6 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`llama-server ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || "";
}

async function viaLocal(chunks, lang, kwAll) {
  const external = !!process.env.LLAMA_URL;
  if (!external && (!existsSync(LLAMA_BIN) || !existsSync(LLAMA_MODEL))) {
    console.log("llama-server / modèle introuvables — repli heuristique.");
    return null;
  }
  let proc = null;
  try {
    if (!external) {
      proc = spawn(LLAMA_BIN, ["-m", LLAMA_MODEL, "-c", "4096", "-t", String(Math.max(1, cpus().length)), "--host", "127.0.0.1", "--port", String(PORT)], { stdio: "ignore" });
    }
    if (!(await waitReady(5 * 60 * 1000))) throw new Error("le serveur n'a pas démarré");
    const sys = systemPrompt(lang);
    const beats = [];
    const prev = [];
    for (let i = 0; i < chunks.length; i++) {
      let best = null, headOnly = null;
      for (let attempt = 0; attempt < 3 && !best; attempt++) {
        try {
          const j = parseJson(await chatLocal(sys, chunkUser(lang, chunks[i], i, chunks.length, prev)));
          const headOk = j && isCleanHeadline(j.headline, lang) && grounded(j.headline, kwAll);
          if (headOk && cardOk(j, lang)) best = j;
          else if (headOk && !headOnly) headOnly = j;
          if (j && !best) console.log(`  extrait ${i + 1}: essai ${attempt + 1} rejeté (${headOk ? "carte hors langue/trop courte" : "headline"})`);
        } catch (e) { console.log(`  extrait ${i + 1}: ${e.message}`); }
      }
      if (!best && headOnly) best = { headline: headOnly.headline, emoji: headOnly.emoji }; // headline OK, carte refaite en repli
      beats.push(best || {});
      if (best) prev.push(best.headline);
      console.log(`  extrait ${i + 1}/${chunks.length} ${best ? "ok" : "→ repli"}`);
    }
    let hook = null;
    try {
      const good = beats.map((b) => b.headline).filter(Boolean);
      if (good.length) hook = parseJson(await chatLocal(sys, hookUser(lang, good), 120));
    } catch {}
    return { hook: hook?.hook, hookEmoji: hook?.emoji, beats };
  } catch (e) {
    console.log(`LLM local en échec (${e.message}) — repli heuristique.`);
    return null;
  } finally {
    if (proc) proc.kill("SIGTERM");
  }
}

// ---------- moteur 3 : repli heuristique ----------
const FILLERS = /^(euh+|heu+|ben|bah|bon|alors|donc|du coup|en fait|genre|voilà|bref|et|mais|puis|so|well|okay|ok|allora|quindi|cioè)[,\s]+/i;
function bestSentence(text, lang) {
  const sents = text.replace(/\s+/g, " ").split(/(?<=[.!?؟])\s+/).map((s) => s.trim()).filter(Boolean);
  const scored = sents.map((s) => {
    let t = s; let p;
    do { p = t; t = t.replace(FILLERS, ""); } while (t !== p);
    t = t.replace(/[.!?؟]+$/, "");
    const n = wordCount(t);
    let sc = (n >= 5 && n <= 11 ? 5 : 0) + (/\d/.test(t) ? 2 : 0) - Math.abs(n - 8) * 0.3;
    if (n > 11) { // coupe sur une virgule, jamais en plein milieu
      const clause = t.split(/[,;:،]\s+/).find((c) => wordCount(c) >= 5 && wordCount(c) <= 11);
      if (clause) { t = clause; sc += 1; } else sc -= 4;
    }
    if (lang !== "ar") t = t.charAt(0).toUpperCase() + t.slice(1);
    return { t, sc };
  }).filter((x) => isCleanHeadline(x.t, lang)).sort((a, b) => b.sc - a.sc);
  return scored[0]?.t || null;
}

function heuristicBeat(chunk, i, lang) {
  const h = bestSentence(chunk.text, lang);
  const ws = chunk.text.split(/\s+/);
  const text = ws.slice(0, 30).join(" ");
  return h ? { headline: h, kicker: KICKERS[lang][i % KICKERS[lang].length], title: "", text, fallback: true } : { fallback: true, kicker: KICKERS[lang][i % KICKERS[lang].length], text };
}

// ---------- main ----------
async function main() {
  const tr = JSON.parse(readFileSync(TR, "utf8"));
  const lang = tr.lang || "fr";
  const chunks = makeChunks(tr.words, tr.duration);
  const kwAll = keywords(chunks.map((c) => c.text).join(" "));
  console.log(`Langue ${lang}, ${chunks.length} beats sur ${tr.duration.toFixed(0)} s.`);

  let res = (await viaApi(chunks, lang)) || (await viaLocal(chunks, lang, kwAll));
  let engine = res ? (res.engine || "local") : "heuristique";
  const raw = res?.beats || [];

  // Headlines manuelles (content/manual-headlines.txt) : prioritaires, une par beat dans l'ordre.
  let manual = [];
  if (existsSync(MANUAL)) manual = readFileSync(MANUAL, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  const degraded = engine === "heuristique";
  const norm = (t) => String(t).replace(/[\p{P}\p{S}\u00A0]/gu, "").replace(DIACRITICS, "").trim();
  const cleanEmoji = (e, i) => (String(e || "").match(/\p{Extended_Pictographic}\uFE0F?/u)?.[0] || EMOJIS[i % EMOJIS.length]);

  const beats = chunks.map((c, i) => {
    if (degraded) {
      // Aucune IA disponible : on NE publie PAS de texte brut tiré d'une transcription bruitée (sans sens).
      // Pas de headline ni de carte ; seules tes headlines manuelles (manual-headlines.txt) sont gardées.
      return { t0: c.t0, t1: c.t1, headline: (manual[i] || "").trim(), emoji: EMOJIS[i % EMOJIS.length], kicker: "", title: "", points: [], text: "", fallback: true };
    }
    const b = { ...(raw[i] || {}) };
    for (const k of ["headline", "kicker", "title", "text"]) if (b[k]) b[k] = tidy(b[k], lang);
    if (Array.isArray(b.points)) b.points = b.points.map((x) => tidy(String(x), lang));
    // headline : propre ; "ancrée dans le contenu" seulement pour le petit LLM local (les IA en ligne reformulent en littéraire)
    const headOk = isCleanHeadline(b.headline, lang) && (engine !== "local" || grounded(b.headline, kwAll));
    let headline = headOk ? b.headline : "";
    if (manual[i]) headline = manual[i];
    // carte : 3 points propres, sinon texte propre, sinon PAS de carte (jamais de citation brute)
    let points = [], text = "";
    if (pointsOk(b, lang)) { points = b.points.slice(0, 4); text = points.join(" "); }
    else if (isCleanCardText(b.text, lang)) text = b.text;
    const hasCard = !!(points.length || text);
    const kicker = hasCard && b.kicker && !foreignScript(b.kicker, lang) && wordCount(b.kicker) <= 4 ? b.kicker : KICKERS[lang][i % KICKERS[lang].length];
    const title = hasCard && b.title && !foreignScript(b.title, lang) && wordCount(b.title) <= 10 ? b.title : "";
    return { t0: c.t0, t1: c.t1, headline: (headline || "").trim(), emoji: cleanEmoji(b.emoji, i), kicker: hasCard ? kicker : "", title, points, text, fallback: !headOk || !hasCard };
  });

  // mots-clés (affichés à l'écran quand le locuteur les prononce en mode "keywords")
  const tokSet = new Set(tr.words.map((w) => norm(w.w)).filter(Boolean));
  let kws = (Array.isArray(res?.keywords) ? res.keywords : []).map(norm).filter((k) => k.length >= 3 && tokSet.has(k));
  if (kws.length < 8) {
    const freq = new Map();
    for (const w of tr.words) { const t = norm(w.w); if (t.length >= 5) freq.set(t, (freq.get(t) || 0) + 1); }
    const extra = [...freq.entries()].sort((a, b) => b[0].length * Math.sqrt(b[1]) - a[0].length * Math.sqrt(a[1])).slice(0, 18).map((x) => x[0]);
    kws = [...kws, ...extra];
  }
  kws = [...new Set(kws)].slice(0, 30);

  if (res?.hook) res.hook = tidy(res.hook, lang);
  let hook = !degraded && res?.hook && wordCount(res.hook) >= 3 && wordCount(res.hook) <= 14 ? res.hook.trim() : "";
  if (!hook && !degraded) {
    const h0 = beats.find((x) => x.headline)?.headline || "";
    hook = h0 ? h0.replace(/[.!؟?]+$/, "") + (lang === "fr" || lang === "it" ? " !" : "!") : "";
  }
  const plan = {
    lang, engine, degraded, duration: tr.duration,
    hook, hookEmoji: (res?.hookEmoji || "🤯").trim(),
    disclaimers: DISCLAIMERS[lang],
    keywords: kws,
    beats,
  };
  writeFileSync(OUT, JSON.stringify(plan, null, 2));
  if (degraded) {
    console.log("⚠⚠⚠ AUCUNE IA n'a répondu (clé refusée ? voir les messages plus haut) : montage SANS headlines ni cartes,");
    console.log("     uniquement sous-titres + effets. Corrige la clé (GEMINI_API_KEY / GROQ_API_KEY) et relance.");
  }
  console.log(`plan.json écrit (moteur : ${engine}${hook ? `, hook : « ${hook} »` : ""}), ${beats.filter((x) => x.points.length || x.text).length}/${beats.length} cartes, ${kws.length} mots-clés.`);
  beats.forEach((x, i) => console.log(`  ${i + 1}. [${x.t0.toFixed(0)}s] ${x.headline || "(pas de headline)"}${x.points.length ? `  | ${x.points.length} points` : ""}`));
}

main();
