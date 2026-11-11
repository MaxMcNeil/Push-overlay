// scripts/lib/gulf-themes.mjs — habillage par pays du Golfe pour « Faceless live arabic ».
// Le pays est détecté dans le texte prononcé (mots-clés ar/fr/en/it) : un seul pays dominant → sa palette ;
// plusieurs pays (ou aucun) → palette « Golfe » bleu nuit + or (celle du logo Gulf think-tank).
// Chaque scène peut en plus porter son propre pays : ses accents changent, le fond reste celui de la vidéo.

const T = (o) => ({ ink: "#F7F3EA", paper: "#F1EBDD", paper2: "#DED6C2", paperInk: "#12181A", ...o });

export const THEMES = {
  gcc: T({ deep: "#050B18", deep2: "#0B1A33", c1: "#123A6B", c2: "#0E6B5C", c3: "#7A1F3D", accent: "#E9BE5A", accent2: "#F6E2A8", paperAccent: "#0E2A4D" }),
  sa: T({ deep: "#03110A", deep2: "#06281A", c1: "#006C35", c2: "#0F8F4F", c3: "#B8962E", accent: "#E6C36A", accent2: "#7BE0A6", paperAccent: "#006C35" }),
  ae: T({ deep: "#070A09", deep2: "#0D1F17", c1: "#00732F", c2: "#B5121B", c3: "#3A3A3A", accent: "#EAC774", accent2: "#FF6B74", paperAccent: "#00732F" }),
  qa: T({ deep: "#12030A", deep2: "#2A0817", c1: "#8A1538", c2: "#5C0E26", c3: "#B88A5A", accent: "#F1D3A8", accent2: "#F08FAE", paperAccent: "#8A1538" }),
  kw: T({ deep: "#050908", deep2: "#0A2116", c1: "#007A3D", c2: "#CE1126", c3: "#2B2B2B", accent: "#F2D58A", accent2: "#5FE3A1", paperAccent: "#007A3D" }),
  om: T({ deep: "#110405", deep2: "#2B0A0D", c1: "#C8102E", c2: "#0B7A3B", c3: "#8A6B2A", accent: "#F3D48B", accent2: "#FF8A8F", paperAccent: "#A30D25" }),
  bh: T({ deep: "#120406", deep2: "#2C090E", c1: "#CE1126", c2: "#7A0E1C", c3: "#9A9A9A", accent: "#F5E6C8", accent2: "#FF7A85", paperAccent: "#CE1126" }),
};

export const COUNTRIES = {
  sa: { colors: ["#006C35", "#FFFFFF"], name: { ar: "السعودية", fr: "Arabie saoudite", en: "Saudi Arabia", it: "Arabia Saudita" },
    kw: ["السعودية", "السعوديه", "الرياض", "جدة", "نيوم", "أرامكو", "ارامكو", "arabie saoudite", "saoudien", "saoudienne", "saudi", "riyad", "riyadh", "ksa", "aramco", "neom", "djeddah", "jeddah", "arabia saudita", "saudita"] },
  ae: { colors: ["#00732F", "#FFFFFF", "#000000", "#FF0000"], name: { ar: "الإمارات", fr: "Émirats arabes unis", en: "UAE", it: "Emirati Arabi Uniti" },
    kw: ["الإمارات", "الامارات", "أبوظبي", "ابوظبي", "دبي", "الشارقة", "émirats", "emirats", "émirati", "emirati", "uae", "abu dhabi", "abou dabi", "dubai", "dubaï", "emirates"] },
  qa: { colors: ["#8A1538", "#FFFFFF"], name: { ar: "قطر", fr: "Qatar", en: "Qatar", it: "Qatar" },
    kw: ["قطر", "الدوحة", "القطري", "القطرية", "qatar", "qatari", "qatarien", "doha"] },
  kw: { colors: ["#007A3D", "#FFFFFF", "#CE1126", "#000000"], name: { ar: "الكويت", fr: "Koweït", en: "Kuwait", it: "Kuwait" },
    kw: ["الكويت", "الكويتي", "الكويتية", "koweït", "koweit", "koweïtien", "kuwait", "kuwaiti"] },
  om: { colors: ["#C8102E", "#FFFFFF", "#008000"], name: { ar: "عُمان", fr: "Oman", en: "Oman", it: "Oman" },
    kw: ["عمان", "عُمان", "سلطنة", "مسقط", "العماني", "العمانية", "oman", "omanais", "omani", "mascate", "muscat", "sultanat"] },
  bh: { colors: ["#CE1126", "#FFFFFF"], name: { ar: "البحرين", fr: "Bahreïn", en: "Bahrain", it: "Bahrein" },
    kw: ["البحرين", "المنامة", "البحريني", "bahreïn", "bahrein", "bahrain", "manama"] },
};
export const CODES = Object.keys(COUNTRIES);

const norm = (s) => String(s || "").toLowerCase().replace(/[ً-ٰٟـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي");

/** Compte les mentions de chaque pays dans un texte. « عمان » seul est ambigu (Amman) : il ne compte que si un autre mot omanais confirme. */
export function countMentions(text) {
  const t = " " + norm(text).replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
  const hits = {}; let weakOman = 0;
  for (const code of CODES) {
    let n = 0, strong = 0;
    for (const k of COUNTRIES[code].kw) {
      const kk = norm(k);
      // préfixes arabes courants (و ب ل ف ك + ال) acceptés devant le mot
      const re = new RegExp(`(?<= )(?:[وبلفك]?(?:ال)?)?${kk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?= )`, "gu");
      const c = (t.match(re) || []).length;
      n += c;
      if (code !== "om" || kk !== "عمان") strong += c;
    }
    if (code === "om" && !strong) { weakOman = n; n = 0; }
    if (n) hits[code] = n;
  }
  // « عمان » seul : compté seulement si au moins deux autres pays du Golfe sont cités (énumération du Golfe, pas Amman)
  if (weakOman && Object.keys(hits).length >= 2) hits.om = weakOman;
  return hits;
}

/** Choix du thème global. force = code pays, "gcc" ou "" (auto). */
export function detectTheme(text, force = "") {
  const f = String(force || "").toLowerCase();
  const hits = countMentions(text);
  const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, x) => s + x[1], 0);
  let code = "gcc", why = "aucun pays du Golfe reconnu : palette Golfe (bleu nuit + or)";
  if (f && (THEMES[f])) { code = f; why = `thème imposé : ${f}`; }
  else if (sorted.length === 1 || (sorted.length > 1 && sorted[0][1] / total >= 0.6 && sorted[0][1] >= 2 * sorted[1][1])) {
    code = sorted[0][0]; why = `pays dominant : ${code} (${sorted[0][1]}/${total} mentions)`;
  } else if (sorted.length > 1) why = `plusieurs pays (${sorted.map((x) => `${x[0]}×${x[1]}`).join(", ")}) : palette Golfe`;
  return { code, theme: THEMES[code], hits, countries: sorted.map((x) => x[0]), why };
}

/** Accents d'une scène consacrée à un pays (le fond global ne change pas). */
export function sceneAccent(code) {
  const t = THEMES[code];
  return t && code !== "gcc" ? { accent: t.accent, accent2: t.accent2, c1: t.c1, paperAccent: t.paperAccent } : null;
}

export const countryChip = (code, lang) => ({ name: COUNTRIES[code].name[lang] || COUNTRIES[code].name.en, colors: COUNTRIES[code].colors });
