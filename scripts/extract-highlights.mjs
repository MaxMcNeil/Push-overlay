// scripts/extract-highlights.mjs
// Découpe content/script.txt en phrases, note chacune avec une heuristique simple
// (mots-clés d'alerte/chiffres/annonce, présence de chiffres, longueur idéale pour un bandeau),
// et garde les meilleures comme accroches. Aucune dépendance externe, aucun appel réseau.

import { readFileSync, writeFileSync, existsSync } from "fs";

const SRC = "content/script.txt";
const OUT = "content/highlights.json";
const CHANNEL = "LE JOURNAL DU NON";
const MAX_ITEMS = 26;
const MIN_LEN = 35;
const MAX_LEN = 130;

const CATEGORY_RULES = [
  { cat: "ALERTE", words: ["alerte", "danger", "risque", "urgence", "menace", "grave"] },
  { cat: "CHIFFRES", words: ["million", "milliard", "%", "pourcent", "hausse", "baisse", "record"] },
  { cat: "EXCLUSIF", words: ["exclusif", "révèle", "révélation", "annonce", "annoncé"] },
  { cat: "SCIENCE", words: ["étude", "recherche", "scientifique", "science", "laboratoire"] },
  { cat: "ANALYSE", words: ["selon", "estime", "analyse", "explique", "souligne"] },
  { cat: "RÉGULATION", words: ["loi", "gouvernement", "régulation", "interdit", "légal", "obligatoire"] },
];

function guessCategory(sentence) {
  const low = sentence.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => low.includes(w))) return rule.cat;
  }
  return "INFO";
}

function scoreSentence(s) {
  let score = 0;
  const len = s.length;
  if (len >= MIN_LEN && len <= MAX_LEN) score += 3;
  else if (len < MIN_LEN) score -= 2;
  else score -= 1; // trop long, sera tronqué -> moins bon
  if (/\d/.test(s)) score += 2; // contient un chiffre/date
  if (/[%€$]/.test(s)) score += 1;
  const low = s.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => low.includes(w))) {
      score += 2;
      break;
    }
  }
  return score;
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

function toHeadline(s) {
  let t = s.replace(/[.]+$/, "").trim();
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN - 1).trim() + "…";
  return t.toUpperCase();
}

function todayTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function main() {
  if (!existsSync(SRC)) {
    throw new Error(`${SRC} introuvable. Fournis content/script.txt ou laisse transcribe.mjs le générer.`);
  }
  const text = readFileSync(SRC, "utf8");
  const sentences = splitSentences(text);

  if (sentences.length === 0) {
    throw new Error("Aucune phrase exploitable trouvée dans le transcript.");
  }

  const ranked = sentences
    .map((s) => ({ s, score: scoreSentence(s) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ITEMS);

  // remet les accroches sélectionnées dans leur ordre d'origine (plus naturel à l'écran)
  const originalOrder = sentences
    .map((s, idx) => ({ s, idx }))
    .filter((o) => ranked.some((r) => r.s === o.s))
    .sort((a, b) => a.idx - b.idx)
    .map((o) => o.s);

  const date = todayTag();
  const items = originalOrder.map((s) => ({
    c: guessCategory(s),
    s: `${CHANNEL} — ${date}`,
    t: toHeadline(s),
  }));

  if (items.length === 0) {
    throw new Error("Aucune accroche retenue après notation.");
  }

  writeFileSync(OUT, JSON.stringify(items, null, 2), "utf8");
  console.log(`${items.length} accroches écrites dans ${OUT}`);
}

main();
