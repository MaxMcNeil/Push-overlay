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

import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { cpus } from "os";
import { CONTENT_DIR, wordCount } from "./lib/util.mjs";

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
    "- Pas de \"je\". Pas d'hésitation orale. Varier les formes d'un extrait à l'autre (affirmation, question, contraste).",
    "",
    "RÈGLES DE LA CARTE D'ANALYSE (valeur ajoutée) :",
    "- kicker : 1 à 3 mots (ex. POURQUOI ?, LE CONTEXTE, COMMENT ÇA MARCHE).",
    "- title : 3 à 8 mots, une idée forte.",
    "- text : 22 à 34 mots. N'est PAS un résumé : explique le POURQUOI ou le COMMENT, ou donne un éclairage de contexte général et vérifiable. Phrases courtes et claires. Pas de chiffres non présents dans l'extrait.",
    "- emoji : UN seul emoji pertinent.",
  ].join("\n");
}

function chunkUser(lang, chunk, i, n, prevHeadlines) {
  return [
    `Extrait ${i + 1}/${n} de la vidéo :`,
    `"""${chunk.text.slice(0, 1400)}"""`,
    prevHeadlines.length ? `Headlines déjà utilisées (ne pas répéter l'angle) : ${prevHeadlines.slice(-4).join(" | ")}` : "",
    `Réponds UNIQUEMENT par un objet JSON : {"headline":"...","emoji":"...","kicker":"...","title":"...","text":"..."} en ${LANG_NAME[lang]}.`,
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

// ---------- moteur 1 : Claude via API (optionnel) ----------
async function viaClaude(chunks, lang) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const sys = systemPrompt(lang);
  const user = [
    "Voici la vidéo découpée en extraits horodatés :",
    chunks.map((c, i) => `[#${i + 1}] (${c.t0.toFixed(0)}s-${c.t1.toFixed(0)}s) ${c.text.slice(0, 1400)}`).join("\n\n"),
    "",
    `Produis le scénario complet. Réponds UNIQUEMENT par un objet JSON : {"hook":"...","hook_emoji":"...","beats":[{"headline":"...","emoji":"...","kicker":"...","title":"...","text":"..."}]} avec EXACTEMENT ${chunks.length} beats (un par extrait, dans l'ordre), tout en ${LANG_NAME[lang]}. Le hook est une question percutante ou une affirmation choc de 5 à 10 mots.`,
  ].join("\n");
  try {
    const res = await fetch(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 6000, system: sys, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const j = parseJson(data.content.map((c) => c.text || "").join(""));
    if (!j || !Array.isArray(j.beats)) throw new Error("JSON inattendu");
    return { hook: j.hook, hookEmoji: j.hook_emoji, beats: j.beats };
  } catch (e) {
    console.log(`Claude indisponible (${e.message}) — repli sur le LLM local.`);
    return null;
  }
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
      let best = null;
      for (let attempt = 0; attempt < 2 && !best; attempt++) {
        try {
          const j = parseJson(await chatLocal(sys, chunkUser(lang, chunks[i], i, chunks.length, prev)));
          if (j && isCleanHeadline(j.headline, lang) && grounded(j.headline, kwAll)) best = j;
          else if (j) console.log(`  extrait ${i + 1}: headline rejetée (« ${j.headline} »), nouvel essai`);
        } catch (e) { console.log(`  extrait ${i + 1}: ${e.message}`); }
      }
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

  let res = (await viaClaude(chunks, lang)) || (await viaLocal(chunks, lang, kwAll));
  let engine = res ? (process.env.ANTHROPIC_API_KEY ? "claude/local" : "local") : "heuristique";
  const raw = res?.beats || [];

  // Headlines manuelles (content/manual-headlines.txt) : prioritaires, une par beat dans l'ordre.
  let manual = [];
  if (existsSync(MANUAL)) manual = readFileSync(MANUAL, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  const beats = chunks.map((c, i) => {
    let b = raw[i] || {};
    if (!(isCleanHeadline(b.headline, lang) && grounded(b.headline, kwAll))) b = { ...heuristicBeat(c, i, lang), ...(b.text && !b.fallback ? { text: b.text } : {}) };
    if (manual[i]) b.headline = manual[i];
    if (!b.headline) b.headline = c.text.split(/\s+/).slice(0, 9).join(" ");
    return {
      t0: c.t0, t1: c.t1,
      headline: b.headline.trim(),
      emoji: (b.emoji || EMOJIS[i % EMOJIS.length]).trim(),
      kicker: (b.kicker || KICKERS[lang][i % KICKERS[lang].length]).trim(),
      title: (b.title ?? "").trim(),
      text: (b.text || "").trim(),
      fallback: !!b.fallback,
    };
  });

  let hook = res?.hook && wordCount(res.hook) >= 3 && wordCount(res.hook) <= 14 ? res.hook.trim() : null;
  if (!hook) {
    // repli : la 1re headline devient le hook, telle quelle (pas de "?" artificiel qui changerait le sens)
    hook = beats[0].headline.replace(/[.!؟?]+$/, "") + (lang === "fr" || lang === "it" ? " !" : "!");
  }
  const plan = {
    lang, engine, duration: tr.duration,
    hook, hookEmoji: (res?.hookEmoji || "🤯").trim(),
    disclaimers: DISCLAIMERS[lang],
    beats,
  };
  writeFileSync(OUT, JSON.stringify(plan, null, 2));
  console.log(`plan.json écrit (moteur : ${engine}, hook : « ${hook} »).`);
  beats.forEach((b, i) => console.log(`  ${i + 1}. [${b.t0.toFixed(0)}s] ${b.headline}${b.fallback ? "  (repli)" : ""}`));
}

main();
