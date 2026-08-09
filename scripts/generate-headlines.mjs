// scripts/generate-headlines.mjs
// Génère des headlines "choc" façon newsroom à partir de content/script.txt,
// via un petit LLM local (Qwen2.5-1.5B-Instruct, quantisé, exécuté par
// llama.cpp — binaire compilé et modèle téléchargé par le workflow, tous
// deux mis en cache). Aucune clé API, aucun service payant, tout tourne sur
// le runner GitHub Actions.
//
// Principe (repris de la suggestion) :
//   script complet -> LLM (plusieurs angles : choc / indignation / curiosité
//   / ironie / révélation / question) -> ~30 candidats -> dédoublonnage ->
//   score (impact / curiosité / clarté / fidélité au texte) -> top N.
//
// Filet de sécurité : si le binaire/modèle est absent, si l'appel échoue, ou
// si trop peu de headlines exploitables sont produites, on retombe
// automatiquement sur le nettoyage heuristique de extract-highlights.mjs —
// le pipeline ne casse jamais pour ce step.

import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { cpus } from "os";
import {
  SRC,
  OUT,
  CHANNEL,
  MAX_ITEMS,
  CATEGORY_RULES,
  guessCategory,
  dedupe,
  todayTag,
  heuristicFallback,
} from "./extract-highlights.mjs";

const LLAMA_BIN = "llama.cpp/build/bin/llama-cli";
const LLAMA_MODEL = "llama.cpp/models/qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MAX_SOURCE_CHARS = 6000; // largement dans le contexte du modèle, garde la génération rapide
const N_PREDICT = 900; // budget de tokens pour ~24 headlines courtes (réduit pour rester dans le temps imparti)
const MIN_VALID_HEADLINES = 6; // en dessous, on considère que le LLM a échoué
const TIMEOUT_MS = 12 * 60 * 1000; // 12 min de garde-fou (CPU seul sur le runner)
const NUM_THREADS = Math.max(1, cpus().length);

const CHOC_WORDS = [
  "scandale", "choc", "choquant", "révélation", "inadmissible", "honte",
  "stupéfiant", "dingue", "hallucinant", "glaçant", "incroyable", "polémique",
  "colère", "alerte", "danger", "explosif", "secret", "caché", "vérité",
];

const STOPWORDS = new Set([
  "le","la","les","un","une","des","de","du","au","aux","et","ou","mais","donc",
  "car","or","ni","que","qui","quoi","dont","où","à","dans","sur","sous","par",
  "pour","avec","sans","ce","cette","ces","cet","son","sa","ses","leur","leurs",
  "il","elle","ils","elles","on","nous","vous","je","tu","est","sont","était",
  "être","avoir","a","ont","plus","très","bien","tout","toute","tous","toutes",
  "pas","ne","se","ça","comme","alors","aussi","entre","vers",
]);

function buildPrompt(sourceText) {
  const system = [
    "Tu es un rédacteur en chef spécialisé dans les titres d'actualité viraux, pour un bandeau d'infos défilant façon chaîne d'info continue, en français.",
    "On te donne un extrait de transcription orale. À partir de ce texte UNIQUEMENT :",
    "1. Identifie le fait principal et l'élément le plus surprenant ou marquant.",
    "2. Ignore les détails secondaires et les hésitations orales.",
    "3. Génère des titres très courts (8 à 14 mots), en français naturel, à la 3e personne (jamais \"je\").",
    "4. Varie les angles : choc, indignation, curiosité, ironie, révélation, question.",
    "5. N'invente AUCUN fait absent du texte source — reformule, n'ajoute rien.",
    "6. Évite les formulations génériques et les répétitions entre titres.",
    "7. Réponds UNIQUEMENT par une liste numérotée (1. 2. 3. ...) de 24 titres, un par ligne, sans aucun autre texte avant ou après.",
  ].join("\n");

  const user = `Texte source :\n"""\n${sourceText}\n"""\n\nGénère la liste de 24 titres maintenant.`;

  // Format ChatML utilisé par Qwen2.5 — construit à la main pour rester
  // compatible avec toutes les versions récentes de llama-cli (mode
  // complétion pure, pas de dépendance à un flag --chat-template précis).
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

const LLAMA_OUT_TMP = "llama_headlines_output.tmp.txt";

function runLlama(prompt) {
  const args = [
    "-m", LLAMA_MODEL,
    "-p", prompt,
    "-n", String(N_PREDICT),
    "-c", "8192",
    "-t", String(NUM_THREADS),
    "--temp", "0.85",
    "--top-p", "0.9",
    "--repeat-penalty", "1.15",
    "-no-cnv",
    "--simple-io",
  ];
  // On redirige stdout vers un fichier plutôt que de le capturer via un pipe
  // Node classique : avec execFileSync/spawnSync, un enfant qui écrit
  // beaucoup et vite (logs de chargement du modèle + génération) peut
  // saturer le pipe synchrone et faire planter Node avec ENOBUFS, même quand
  // llama-cli tourne parfaitement. Écrire directement sur disque contourne
  // ce bug connu de Node.
  const fd = openSync(LLAMA_OUT_TMP, "w");
  try {
    execFileSync(LLAMA_BIN, args, {
      stdio: ["ignore", fd, "ignore"], // stdout -> fichier, stderr ignoré (logs de chargement bruyants)
      timeout: TIMEOUT_MS,
    });
  } finally {
    closeSync(fd);
  }
  const out = readFileSync(LLAMA_OUT_TMP, "utf8");
  try {
    unlinkSync(LLAMA_OUT_TMP);
  } catch {
    /* pas grave si le nettoyage échoue */
  }
  return out;
}

// Extrait les lignes "N. texte" du brut renvoyé par llama-cli. On ne suppose
// rien d'autre sur le format de sortie (le prompt lui-même ne contient
// aucune ligne numérotée, donc pas de faux positifs si le prompt est réécho).
function parseHeadlines(raw) {
  const lines = raw.split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*\d{1,2}[.)]\s+(.{6,200})$/);
    if (!m) continue;
    let t = m[1].trim();
    t = t.replace(/^["«]+|["»]+$/g, "").trim(); // guillemets superflus
    t = t.replace(/<\|im_end\|>.*$/, "").trim();
    if (t.length >= 8) out.push(t);
  }
  return out;
}

function sourceKeywords(sourceText) {
  return new Set(
    sourceText
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
  );
}

// Garde-fou anti-hallucination très simple : au moins un mot significatif du
// titre doit apparaître dans le texte source. Imparfait (n'empêche pas une
// reformulation abusive) mais élimine les titres complètement hors-sujet.
function isGroundedInSource(headline, keywords) {
  const words = headline
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return words.some((w) => keywords.has(w));
}

function scoreHeadline(t) {
  let score = 0;
  const len = t.length;
  if (len >= 25 && len <= 75) score += 3; // clarté / punchy pour un bandeau
  else if (len > 100) score -= 3;
  if (t.includes("?")) score += 2; // curiosité
  const low = t.toLowerCase();
  if (CHOC_WORDS.some((w) => low.includes(w))) score += 2; // impact
  if (/\d/.test(t)) score += 1;
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => low.includes(w))) {
      score += 1;
      break;
    }
  }
  return score;
}

function generateViaLLM(sourceText) {
  if (!existsSync(LLAMA_BIN) || !existsSync(LLAMA_MODEL)) {
    console.log("llama-cli ou le modèle sont introuvables — repli sur le nettoyage heuristique.");
    return null;
  }

  const truncated =
    sourceText.length > MAX_SOURCE_CHARS ? sourceText.slice(0, MAX_SOURCE_CHARS) : sourceText;

  let raw;
  try {
    raw = runLlama(buildPrompt(truncated));
  } catch (err) {
    console.log(`Échec de l'appel llama-cli (${err.message}) — repli sur le nettoyage heuristique.`);
    return null;
  }

  const candidates = parseHeadlines(raw);
  const keywords = sourceKeywords(truncated);
  const grounded = candidates.filter((t) => isGroundedInSource(t, keywords));
  const deduped = dedupe(grounded);

  if (deduped.length < MIN_VALID_HEADLINES) {
    console.log(
      `Seulement ${deduped.length} headline(s) valable(s) généré(es) (< ${MIN_VALID_HEADLINES}) — repli sur le nettoyage heuristique.`
    );
    return null;
  }

  const ranked = deduped
    .map((t) => ({ t, score: scoreHeadline(t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS)
    .map((r) => r.t);

  const date = todayTag();
  const items = ranked.map((t) => ({
    c: guessCategory(t),
    s: `${CHANNEL} — ${date}`,
    t: t.toUpperCase(),
  }));

  return items;
}

function main() {
  if (!existsSync(SRC)) {
    throw new Error(`${SRC} introuvable. Fournis content/script.txt ou laisse transcribe.mjs le générer.`);
  }
  const text = readFileSync(SRC, "utf8");
  if (text.trim().length === 0) {
    throw new Error(
      `${SRC} est vide. Soit tu colles ton texte dedans, soit la vidéo n'a produit aucune transcription exploitable.`
    );
  }

  let items = generateViaLLM(text);
  let mode = "llm";
  if (!items) {
    items = heuristicFallback(text);
    mode = "heuristique (repli)";
  }

  writeFileSync(OUT, JSON.stringify(items, null, 2), "utf8");
  console.log(`${items.length} accroches écrites dans ${OUT} (mode: ${mode})`);
}

main();
