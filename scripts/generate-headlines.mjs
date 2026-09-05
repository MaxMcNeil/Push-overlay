// scripts/generate-headlines.mjs
// PRIORITÉ 1 : si content/manual-headlines.txt contient des lignes, elles
// sont utilisées telles quelles (un titre par ligne), sans passer ni par le
// LLM ni par le nettoyage heuristique. C'est le mode "je choisis mes propres
// titres" — voir readManualHeadlines() plus bas.
//
// PRIORITÉ 2 (si le fichier manuel est vide/absent) : génère des headlines
// "choc" façon newsroom à partir de content/script.txt, via un petit LLM
// local (Qwen2.5-1.5B-Instruct, quantisé, exécuté par llama.cpp — binaire
// compilé et modèle téléchargé par le workflow, tous deux mis en cache).
// Aucune clé API, aucun service payant, tout tourne sur le runner GitHub
// Actions.
//
// Principe : script complet -> LLM (plusieurs angles : choc / indignation /
// curiosité / ironie / révélation / question) -> ~24 candidats ->
// dédoublonnage -> score (impact / curiosité / clarté / fidélité au texte)
// -> top N.
//
// Filet de sécurité : si le binaire/modèle est absent, si l'appel échoue, ou
// si trop peu de headlines exploitables sont produites, on retombe
// automatiquement sur le nettoyage heuristique de extract-highlights.mjs —
// le pipeline ne casse jamais pour ce step.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { cpus } from "os";
import {
  SRC,
  OUT,
  MAX_ITEMS,
  CATEGORY_RULES,
  guessCategory,
  dedupe,
  heuristicFallback,
  detectLanguage,
  channelFor,
} from "./extract-highlights.mjs";

const MANUAL_HEADLINES_PATH = "content/manual-headlines.txt";

// Disclaimers légaux/éditoriaux — toujours injectés en tête de highlights.json,
// quel que soit le mode de génération (manuel, LLM, ou repli heuristique).
// Comme le player (templates/*.html) boucle sur le tableau d'items via
// `i = (i+1) % items.length`, les placer en position 0/1/2 garantit qu'ils
// ouvrent CHAQUE cycle de la boucle perpétuelle, pas seulement le tout premier
// affichage.
const DISCLAIMER_HEADLINES_FR = [
  "Clause de non-responsabilité : les informations proposées ne constituent pas des vérités définitives et peuvent comporter des inexactitudes. Chaque utilisateur est invité à procéder à ses propres vérifications",
  "Mes propos reflètent mon opinion et ne constituent pas une vérité absolue. À chacun de vérifier et de croiser les sources",
  "Exercé au titre de la liberté d'expression (Art. 19 DUDH), ce contenu informatif peut comporter des erreurs. Il appartient à chacun de croiser et vérifier les sources",
];

// Mêmes trois clauses, en arabe — utilisées quand le contenu de l'overlay
// (vidéo transcrite ou texte saisi dans content/manual-headlines.txt) est en
// arabe, pour que le disclaimer ne s'affiche jamais dans une langue
// différente du reste de l'overlay.
const DISCLAIMER_HEADLINES_AR = [
  "إخلاء مسؤولية: المعلومات المقدمة لا تشكل حقائق نهائية وقد تحتوي على أخطاء. كل مستخدم مدعو للتحقق بنفسه من المعلومات",
  "آرائي تعكس وجهة نظري الشخصية ولا تشكل حقيقة مطلقة. لكل شخص أن يتحقق من المصادر ويقارن بينها",
  "يُقدَّم هذا المحتوى الإعلامي في إطار حرية التعبير (المادة 19 من الإعلان العالمي لحقوق الإنسان)، وقد يتضمن أخطاء. يتوجب على كل شخص التحقق من المصادر ومقارنتها",
];

function buildDisclaimerItems(lang) {
  // Pas de date ici : calculée en direct côté client (templates/*.html).
  const headlines = lang === "ar" ? DISCLAIMER_HEADLINES_AR : DISCLAIMER_HEADLINES_FR;
  return headlines.map((t) => ({
    c: "AVIS",
    s: channelFor(lang),
    t: t.toUpperCase(),
  }));
}

// Lit content/manual-headlines.txt : une headline par ligne, lignes vides ou
// commençant par # ignorées. Retourne null si le fichier est absent ou vide
// (auquel cas on continue vers LLM/heuristique), sinon la liste d'items prête
// pour highlights.json.
function readManualHeadlines() {
  if (!existsSync(MANUAL_HEADLINES_PATH)) return null;
  const raw = readFileSync(MANUAL_HEADLINES_PATH, "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return null;

  const lang = detectLanguage(lines.join(" "));
  return lines.map((t) => ({
    c: guessCategory(t, lang),
    s: channelFor(lang),
    t: t.toUpperCase(),
  }));
}

// On pilote llama.cpp via son serveur HTTP (llama-server) plutôt que le CLI
// (llama-cli). Le CLI a été refondu récemment dans llama.cpp (architecture
// client/serveur unifiée) et nos flags de contrôle (-no-cnv, --simple-io)
// s'y comportent de façon imprévisible — génération qui ne se termine
// jamais (ETIMEDOUT) au lieu de planter proprement. L'API HTTP /completion,
// elle, est stable et documentée depuis longtemps.
const LLAMA_SERVER_BIN = "llama.cpp/build/bin/llama-server";
const LLAMA_MODEL = "llama.cpp/models/qwen2.5-1.5b-instruct-q4_k_m.gguf";
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 8811;
const MAX_SOURCE_CHARS = 6000; // largement dans le contexte du modèle, garde la génération rapide
const N_PREDICT = 900; // budget de tokens pour ~24 headlines courtes
const MIN_VALID_HEADLINES = 6; // en dessous, on considère que le LLM a échoué
const SERVER_STARTUP_TIMEOUT_MS = 90 * 1000; // chargement du modèle (1.1 Go, CPU)
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min de garde-fou pour la génération elle-même
const NUM_THREADS = Math.max(1, cpus().length);

const CHOC_WORDS_FR = [
  "scandale", "choc", "choquant", "révélation", "inadmissible", "honte",
  "stupéfiant", "dingue", "hallucinant", "glaçant", "incroyable", "polémique",
  "colère", "alerte", "danger", "explosif", "secret", "caché", "vérité",
];

const CHOC_WORDS_AR = [
  "فضيحة", "صادم", "صادمة", "خطير", "خطيرة", "كارثة", "سر", "مفاجأة",
  "حقيقة", "مخفي", "مخفية", "تحذير", "غضب", "احتجاج", "انفجار",
];

const STOPWORDS_FR = new Set([
  "le","la","les","un","une","des","de","du","au","aux","et","ou","mais","donc",
  "car","or","ni","que","qui","quoi","dont","où","à","dans","sur","sous","par",
  "pour","avec","sans","ce","cette","ces","cet","son","sa","ses","leur","leurs",
  "il","elle","ils","elles","on","nous","vous","je","tu","est","sont","était",
  "être","avoir","a","ont","plus","très","bien","tout","toute","tous","toutes",
  "pas","ne","se","ça","comme","alors","aussi","entre","vers",
]);

// Mots-outils arabes les plus fréquents (prépositions, conjonctions,
// pronoms) — liste courte, non exhaustive, mais suffisante pour ne pas les
// compter comme "mots-clés significatifs" dans le garde-fou anti-hallucination.
const STOPWORDS_AR = new Set([
  "في", "من", "إلى", "على", "عن", "مع", "أن", "إن", "هذا", "هذه", "ذلك",
  "التي", "الذي", "كان", "كانت", "لا", "لم", "لن", "قد", "كل", "بين",
  "هو", "هي", "هم", "أنا", "أنت", "نحن", "و", "أو", "ثم", "كما", "أيضا",
  "فى", "لكن", "بل", "حتى", "إذا", "بعد", "قبل", "عند", "عندما",
]);

// Détecte l'arabe par la proportion de caractères dans le bloc Unicode
// arabe — importé de extract-highlights.mjs (voir ci-dessus), pour éviter
// deux implémentations qui pourraient diverger.

function buildMessages(sourceText, lang) {
  if (lang === "ar") {
    const system = [
      "أنت محرر عناوين لشريط أخبار متحرك على طريقة قناة إخبارية مستمرة. تكتب عناوين قصيرة وقوية فقط — أبداً جملاً تحليلية طويلة.",
      "",
      "قاعدة الطول الصارمة: من 6 إلى 12 كلمة لكل عنوان، لا أكثر. أي عنوان أطول يُعتبر فاشلاً حتى لو كان مضمونه جيداً.",
      "",
      "المفردات: بسيطة، مباشرة، ملموسة — كأنك مذيع نشرة أخبار، وليس أكاديمياً. تجنب الكلمات المجردة والفلسفية.",
      "",
      "الزوايا: من أصل 24 عنواناً، بحد أقصى 4 عناوين يمكن أن تنتهي بعلامة استفهام. الـ20 المتبقية يجب أن تكون جملاً تقريرية — صادمة، ساخرة، أو كاشفة. لا تستخدم السؤال كحل سهل.",
      "",
      "أمثلة على الأسلوب المطلوب (الأسلوب فقط، وليس الموضوع):",
      "سيئ (طويل جداً ومجرد): \"هل تم خداع الجمهور من خلال تصوير خطورة الأمراض ومدى فعالية الوقاية منها؟\"",
      "جيد: \"دراسات مخفية منذ 40 عاماً\"",
      "جيد: \"عضو مجلس الشيوخ وملايين شركات الأدوية\"",
      "جيد: \"ما لم يجرؤ على قوله في الجلسة\"",
      "",
      "المنهج:",
      "1. حدد الحقيقة الرئيسية والعنصر الأكثر إثارة للدهشة في النص.",
      "2. تجاهل التفاصيل الثانوية والتردد في الكلام المنطوق.",
      "3. لا تختلق أي معلومة غير موجودة في النص المصدر — أعد الصياغة فقط، لا تُضف شيئاً.",
      "4. اكتب بصيغة الغائب، أبداً بصيغة المتكلم \"أنا\".",
      "5. تجنب التكرار بين العناوين — كل عنوان يجب أن يقدم زاوية مختلفة.",
      "6. أجب فقط بقائمة مرقمة (1. 2. 3. ...) من 24 عنواناً، سطر واحد لكل عنوان، دون أي نص آخر قبل أو بعد.",
    ].join("\n");

    const user = `النص المصدر:\n"""\n${sourceText}\n"""\n\nولّد الآن قائمة من 24 عنواناً. تذكير: من 6 إلى 12 كلمة لكل عنوان، لا أكثر.`;

    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }
  const system = [
    "Tu es rédacteur pour un bandeau d'infos défilant façon chaîne d'info continue, en français. Tu écris des titres COURTS et PUNCHY — jamais des phrases d'analyse.",
    "",
    "RÈGLE ABSOLUE DE LONGUEUR : 6 à 12 mots par titre, pas un de plus. Un titre plus long est un échec, même s'il est pertinent.",
    "",
    "VOCABULAIRE : simple, concret, oral — celui d'un présentateur de JT, jamais celui d'un universitaire. Mots INTERDITS : \"objectivation\", \"élitisme\", \"incidence\", \"audience audiovisuelle\", et tout mot abstrait de ce genre.",
    "",
    "ANGLES : sur 24 titres, maximum 4 peuvent finir par un point d'interrogation. Les 20 autres sont des affirmations — choc, ironie, indignation, révélation. N'utilise pas la question comme solution de facilité.",
    "",
    "Exemples de style à IMITER (uniquement le style, pas le sujet ni les faits) :",
    "MAUVAIS (trop long, abstrait) : \"LA POPULATION A-T-ELLE ÉTÉ TROMPÉE PAR L'OBJECTIVATION DE LA GRAVITÉ DES MALADIES ET DE LEUR INCIDENCE PRÉVENTIVE ?\"",
    "BON : \"DES ÉTUDES CACHÉES DEPUIS 40 ANS\"",
    "BON : \"UN SEUL AVOCAT NE SUFFISAIT PAS, IL LUI FALLAIT UNE ARMÉE\"",
    "BON : \"LE SÉNATEUR ET LES MILLIONS DE L'INDUSTRIE PHARMA\"",
    "BON : \"CE QU'IL N'A PAS OSÉ DIRE EN AUDIENCE\"",
    "",
    "MÉTHODE :",
    "1. Identifie le fait principal et l'élément le plus surprenant du texte.",
    "2. Ignore les détails secondaires et les hésitations orales.",
    "3. N'invente AUCUN fait absent du texte source — reformule, n'ajoute rien.",
    "4. Écris à la 3e personne, jamais \"je\".",
    "5. Évite les répétitions entre titres — chaque titre doit apporter un angle différent.",
    "6. Réponds UNIQUEMENT par une liste numérotée (1. 2. 3. ...) de 24 titres, un par ligne, sans aucun autre texte avant ou après.",
  ].join("\n");

  const user = `Texte source :\n"""\n${sourceText}\n"""\n\nGénère la liste de 24 titres maintenant. Rappel : 6 à 12 mots chacun, pas plus.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function waitForServerReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/health`);
        if (res.ok) return resolve(true);
      } catch {
        /* pas encore prêt */
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });
}

async function runLlamaServer(sourceText, lang) {
  const proc = spawn(
    LLAMA_SERVER_BIN,
    [
      "-m", LLAMA_MODEL,
      "-c", "8192",
      "-t", String(NUM_THREADS),
      "--host", SERVER_HOST,
      "--port", String(SERVER_PORT),
    ],
    { stdio: "ignore" }
  );

  let serverErrored = false;
  proc.on("error", () => {
    serverErrored = true;
  });

  try {
    const ready = await waitForServerReady(SERVER_STARTUP_TIMEOUT_MS);
    if (!ready || serverErrored) {
      throw new Error("le serveur llama.cpp n'a pas démarré à temps (modèle trop long à charger, ou binaire absent)");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: buildMessages(sourceText, lang),
          max_tokens: N_PREDICT,
          temperature: 0.85,
          top_p: 0.9,
          repeat_penalty: 1.15,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`llama-server a répondu ${res.status}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    proc.kill("SIGTERM");
  }
}

// Extrait les lignes "N. texte" du brut renvoyé par llama-cli. On ne suppose
// rien d'autre sur le format de sortie (le prompt lui-même ne contient
// aucune ligne numérotée, donc pas de faux positifs si le prompt est réécho).
const MAX_WORDS = 13; // cible 6-12 mots +1 de marge — au-delà ça sonne "analyse", pas "bandeau"
const MAX_QUESTION_SHARE = 4; // sur MAX_ITEMS, au-delà on rejette les "?" en trop (déjà vu: le modèle sur-utilise la question)

function parseHeadlines(raw) {
  const lines = raw.split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*\d{1,2}[.)]\s+(.{6,200})$/);
    if (!m) continue;
    let t = m[1].trim();
    t = t.replace(/^["«]+|["»]+$/g, "").trim(); // guillemets superflus
    t = t.replace(/<\|im_end\|>.*$/, "").trim();
    if (t.length < 8) continue;
    const wordCount = t.split(/\s+/).filter(Boolean).length;
    if (wordCount > MAX_WORDS) continue; // trop long malgré la consigne — on jette plutôt que de tronquer moche
    out.push(t);
  }
  return out;
}

function sourceKeywords(sourceText, lang) {
  const stopwords = lang === "ar" ? STOPWORDS_AR : STOPWORDS_FR;
  return new Set(
    sourceText
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(" ")
      .filter((w) => w.length >= 4 && !stopwords.has(w))
  );
}

// Garde-fou anti-hallucination très simple : au moins un mot significatif du
// titre doit apparaître dans le texte source. Imparfait (n'empêche pas une
// reformulation abusive) mais élimine les titres complètement hors-sujet.
// \p{L}\p{N} (Unicode) et non a-z0-9 (latin) : sans ça, un texte source en
// arabe (ou tout script non-latin) perd toutes ses lettres au nettoyage, le
// set de mots-clés reste vide, et AUCUNE headline ne passe jamais le
// garde-fou -> repli heuristique -> qui plantait aussi pour la même raison
// dans extract-highlights.mjs (corrigé également).
function isGroundedInSource(headline, keywords, lang) {
  const stopwords = lang === "ar" ? STOPWORDS_AR : STOPWORDS_FR;
  const words = headline
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(" ")
    .filter((w) => w.length >= 4 && !stopwords.has(w));
  return words.some((w) => keywords.has(w));
}

function scoreHeadline(t, lang) {
  const chocWords = lang === "ar" ? CHOC_WORDS_AR : CHOC_WORDS_FR;
  let score = 0;
  const len = t.length;
  if (len >= 25 && len <= 75) score += 3; // clarté / punchy pour un bandeau
  else if (len > 100) score -= 3;
  if (t.includes("?") || t.includes("؟")) score += 1; // légère prime à la curiosité, mais plafonnée plus haut
  const low = t.toLowerCase();
  if (chocWords.some((w) => low.includes(w))) score += 2; // impact
  if (/\d/.test(t)) score += 1;
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => low.includes(w))) {
      score += 1;
      break;
    }
  }
  return score;
}

async function generateViaLLM(sourceText) {
  if (!existsSync(LLAMA_SERVER_BIN) || !existsSync(LLAMA_MODEL)) {
    console.log("llama-server ou le modèle sont introuvables — repli sur le nettoyage heuristique.");
    return null;
  }

  const lang = detectLanguage(sourceText);
  const truncated =
    sourceText.length > MAX_SOURCE_CHARS ? sourceText.slice(0, MAX_SOURCE_CHARS) : sourceText;

  let raw;
  try {
    raw = await runLlamaServer(truncated, lang);
  } catch (err) {
    console.log(`Échec de l'appel llama-server (${err.message}) — repli sur le nettoyage heuristique.`);
    return null;
  }

  const candidates = parseHeadlines(raw);
  const keywords = sourceKeywords(truncated, lang);
  const grounded = candidates.filter((t) => isGroundedInSource(t, keywords, lang));
  const deduped = dedupe(grounded);

  if (deduped.length < MIN_VALID_HEADLINES) {
    console.log(
      `Seulement ${deduped.length} headline(s) valable(s) généré(es) (< ${MIN_VALID_HEADLINES}) — repli sur le nettoyage heuristique.`
    );
    return null;
  }

  const sorted = deduped
    .map((t) => ({ t, score: scoreHeadline(t, lang) }))
    .sort((a, b) => b.score - a.score);

  // Plafonne la part de questions dans la sélection finale : le modèle a
  // tendance à sur-utiliser le "?" comme facilité, au détriment des
  // affirmations chocs/ironiques demandées dans le prompt. On garde l'ordre
  // par score mais on saute les questions excédentaires.
  const ranked = [];
  let questionCount = 0;
  for (const { t } of sorted) {
    if (ranked.length >= MAX_ITEMS) break;
    const isQuestion = t.trim().endsWith("?");
    if (isQuestion && questionCount >= MAX_QUESTION_SHARE) continue;
    if (isQuestion) questionCount++;
    ranked.push(t);
  }

  const items = ranked.map((t) => ({
    c: guessCategory(t, lang),
    s: channelFor(lang),
    t: t.toUpperCase(),
  }));

  return items;
}

async function main() {
  const manualItems = readManualHeadlines();
  if (manualItems) {
    // Langue déduite du texte réellement saisi manuellement, pas d'une
    // valeur par défaut — le disclaimer suit la langue de l'overlay.
    const lang = detectLanguage(manualItems.map((it) => it.t).join(" "));
    const disclaimerItems = buildDisclaimerItems(lang);
    const items = [...disclaimerItems, ...manualItems];
    writeFileSync(OUT, JSON.stringify(items, null, 2), "utf8");
    console.log(`${items.length} accroches écrites dans ${OUT} (mode: manuel — ${MANUAL_HEADLINES_PATH}, dont ${disclaimerItems.length} disclaimers, langue: ${lang})`);
    return;
  }

  if (!existsSync(SRC)) {
    throw new Error(`${SRC} introuvable. Fournis content/script.txt ou laisse transcribe.mjs le générer.`);
  }
  const text = readFileSync(SRC, "utf8");
  if (text.trim().length === 0) {
    throw new Error(
      `${SRC} est vide. Soit tu colles ton texte dedans, soit la vidéo n'a produit aucune transcription exploitable.`
    );
  }

  let items = await generateViaLLM(text);
  let mode = "llm";
  if (!items) {
    items = heuristicFallback(text);
    mode = "heuristique (repli)";
  }

  // Langue déduite des accroches réellement générées (source de vérité
  // unique, cohérente avec le channelFor(lang) déjà utilisé dedans) — le
  // disclaimer suit toujours la langue effectivement affichée à l'écran.
  const lang = detectLanguage(items.map((it) => it.t).join(" "));
  const disclaimerItems = buildDisclaimerItems(lang);
  items = [...disclaimerItems, ...items];

  writeFileSync(OUT, JSON.stringify(items, null, 2), "utf8");
  console.log(`${items.length} accroches écrites dans ${OUT} (mode: ${mode}, dont ${disclaimerItems.length} disclaimers, langue: ${lang})`);
}

main();
