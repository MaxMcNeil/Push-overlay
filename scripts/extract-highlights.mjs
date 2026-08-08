// scripts/extract-highlights.mjs
// Découpe content/script.txt en phrases, les nettoie façon "titre newsroom"
// (retire les hésitations orales, coupe sur une clause autonome plutôt qu'en
// plein milieu, dédoublonne), note chacune avec une heuristique simple
// (mots-clés d'alerte/chiffres/annonce, présence de chiffres, longueur idéale
// pour un bandeau), et garde les meilleures comme accroches.
// Aucune dépendance externe, aucun appel réseau, aucune IA — tout est déterministe.
//
// Limite assumée : c'est un nettoyage/sélection de ce qui a été dit, pas une
// réécriture créative. Pour de vrais titres reformulés par IA, il faudrait
// brancher un appel API (Claude, etc.) ici — non fait volontairement pour
// rester à coût zéro.

import { readFileSync, writeFileSync, existsSync } from "fs";

const SRC = "content/script.txt";
const OUT = "content/highlights.json";
const CHANNEL = "LE JOURNAL DU NON";
const MAX_ITEMS = 26;
const MIN_LEN = 35;
const MAX_LEN = 100;

const CATEGORY_RULES = [
  { cat: "ALERTE", words: ["alerte", "danger", "risque", "urgence", "menace", "grave"] },
  { cat: "CHIFFRES", words: ["million", "milliard", "%", "pourcent", "hausse", "baisse", "record"] },
  { cat: "EXCLUSIF", words: ["exclusif", "révèle", "révélation", "annonce", "annoncé"] },
  { cat: "SCIENCE", words: ["étude", "recherche", "scientifique", "science", "laboratoire"] },
  { cat: "ANALYSE", words: ["selon", "estime", "analyse", "explique", "souligne"] },
  { cat: "RÉGULATION", words: ["loi", "gouvernement", "régulation", "interdit", "légal", "obligatoire"] },
];

// Amorces orales à retirer en tête de phrase (répété jusqu'à stabilisation,
// car elles s'enchaînent souvent : "Bon, alors du coup, moi je pense que...").
const LEADING_FILLERS = [
  /^(euh+|heu+|hum+|ben|bah|bon|alors|donc|du coup|en fait|genre|voilà|écoute[sz]?|écoutez|bref|disons|quoi qu'il en soit|à vrai dire)[,:\s]+/i,
  /^(et|mais|puis)\s+/i,
  /^(moi\s+)?je\s+(pense|crois|trouve|considère|dirais|dis)\s+que\s+/i,
  /^(je\s+)?(vous\s+)?(le\s+)?(précise|rappelle|signale)\s+que\s+/i,
  /^ce\s+qui\s+me\s+(fascine|frappe|marque|surprend)(\s*,\s*| c'est\s+que\s+| dans (tout )?(cette|ça)[^,]*,\s*)/i,
];

// Tics oraux isolés (mots seuls) à retirer partout dans la phrase, en
// préservant la ponctuation autour.
const FILLER_TOKENS = /\b(euh+|heu+|hum+|tu vois|hein|quoi|genre|du coup|en fait|voilà|bon ben|bah)\b/gi;

// Petits mots "accrocheurs" (connecteurs) qu'on ne veut jamais laisser
// en fin de titre tronqué — ça sonne inachevé.
const DANGLING_END = /\s+(et|ou|mais|donc|car|que|qui|de|du|des|le|la|les|un|une|à|au|aux|pour|par|sur|dans|avec|sans)$/i;

function stripFillers(s) {
  let t = s;
  let prev;
  do {
    prev = t;
    for (const re of LEADING_FILLERS) t = t.replace(re, "");
  } while (t !== prev && t.length > 0);
  t = t.replace(FILLER_TOKENS, " ");
  t = t.replace(/\s+([,.;:!?])/g, "$1"); // pas d'espace avant la ponctuation
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

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

// Découpe une phrase (déjà nettoyée des tics) en clauses sur les jonctions
// naturelles (virgule, "parce que", "puisque", "alors que"...), pour pouvoir
// choisir une clause autonome plutôt que de tronquer en plein milieu.
function splitClauses(s) {
  return s
    .split(/,\s+|\s+—\s+|\s+;\s+|\s+(?:parce que|puisque|alors que|tandis que)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

// Choisit la meilleure clause (ou la phrase entière) pour tenir dans
// MIN_LEN..MAX_LEN, en repartant du texte le plus riche (chiffres/mots-clés).
function pickHeadlineText(cleaned) {
  if (cleaned.length <= MAX_LEN) return cleaned;

  const clauses = splitClauses(cleaned);
  const candidates = [];
  // clauses seules, et cumuls progressifs de clauses (pour garder du contexte)
  let acc = "";
  for (const c of clauses) {
    acc = acc ? `${acc}, ${c}` : c;
    candidates.push(acc);
  }
  const fitting = candidates.filter((c) => c.length <= MAX_LEN);
  // priorité aux candidats qui tiennent ET qui ont assez de substance —
  // évite de retenir une amorce du style "Bien entendu" toute seule quand
  // la clause suivante, elle, dépasse la limite.
  const solid = fitting.filter((c) => c.length >= MIN_LEN);
  if (solid.length > 0) {
    solid.sort((a, b) => b.length - a.length);
    return solid[0];
  }
  // en dessous de ce seuil, une amorce isolée ("Bien entendu", "Au final")
  // n'apporte rien comme titre — on préfère tronquer la phrase complète.
  const usable = fitting.filter((c) => c.length >= 20);
  if (usable.length > 0) {
    usable.sort((a, b) => b.length - a.length);
    return usable[0];
  }

  // Rien ne tient dans la fourchette : coupe au dernier mot entier avant
  // MAX_LEN (sur la phrase complète, pas juste la 1ère clause) et retire un
  // connecteur pendouillant en fin.
  let t = cleaned.slice(0, MAX_LEN);
  t = t.slice(0, t.lastIndexOf(" ")) || t;
  t = t.replace(DANGLING_END, "");
  return t.trim() + "…";
}

function toHeadline(s) {
  const cleaned = stripFillers(s).replace(/[.]+$/, "").trim();
  let t = pickHeadlineText(cleaned);
  t = t.replace(/[,;:]+$/, "").trim();
  return t.toUpperCase();
}

// Dédoublonne les phrases quasi identiques (redites fréquentes à l'oral :
// "je considère que les gens sont majeurs" répété deux fois de suite, etc.)
function normalizedKey(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
}

function dedupe(sentences) {
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    const key = normalizedKey(s);
    if (key.length < 6 || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
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
  if (text.trim().length === 0) {
    throw new Error(
      `${SRC} est vide. Soit tu colles ton texte dedans, soit la vidéo n'a produit aucune transcription exploitable (vérifie qu'elle contient bien de la parole audible).`
    );
  }
  const rawSentences = splitSentences(text);
  const sentences = dedupe(rawSentences);

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
  const items = originalOrder
    .map((s) => ({
      c: guessCategory(s),
      s: `${CHANNEL} — ${date}`,
      t: toHeadline(s),
    }))
    // au cas où le nettoyage aurait vidé une phrase entière (que des tics)
    .filter((it) => it.t.length >= 8);

  if (items.length === 0) {
    throw new Error("Aucune accroche retenue après notation.");
  }

  writeFileSync(OUT, JSON.stringify(items, null, 2), "utf8");
  console.log(`${items.length} accroches écrites dans ${OUT}`);
}

main();
