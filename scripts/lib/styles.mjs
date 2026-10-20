// scripts/lib/styles.mjs — bibliothèque de THÈMES visuels/sonores.
// Objectif : que deux vidéos d'une même chaîne n'aient pas le même habillage (couleurs, sons, mise en page,
// transitions, sous-titres…), pour ne pas ressembler à un contenu produit à la chaîne. Le traitement (transcription,
// scénario, montage) ne change pas : seul l'habillage varie. Le thème "neon-night" reproduit le rendu d'origine.

const base = {
  radius: 26, transition: "bands", subAnim: "pop", bullet: "dot", flip: false, progress: "bottom", subsDy: 0,
  sfx: 0, energy: "high", frame: "white", pill: "round", hueSpeed: 24, sat: 1.6, tilt: true, stickerSide: "far",
};

export const PRESETS = [
  { id: "neon-night", palette: { accent: "#FF2E63", cyan: "#08D9D6", gold: "#FFD23F", dark: "#0B0F2B", card: "#141A3D" },
    gradient: ["FF2E63", "08D9D6", "7B2FF7"] },
  { id: "sunset", palette: { accent: "#FF6B35", cyan: "#FFB703", gold: "#FFE66D", dark: "#1B0A2A", card: "#2A1240" },
    gradient: ["FF6B35", "F72585", "7209B7"], radius: 40, transition: "wipe", subAnim: "slide", bullet: "square", flip: true, progress: "top", sfx: 2, frame: "gold", pill: "square", hueSpeed: 14 },
  { id: "emerald", palette: { accent: "#00C896", cyan: "#4CC9F0", gold: "#F9F871", dark: "#04141A", card: "#0A2530" },
    gradient: ["00C896", "4CC9F0", "1B998B"], radius: 18, transition: "flash2", subAnim: "drop", bullet: "arrow", sfx: 1, frame: "accent", hueSpeed: 30, sat: 1.35, subsDy: -24 },
  { id: "royal", palette: { accent: "#9B5DE5", cyan: "#00BBF9", gold: "#FEE440", dark: "#120B2E", card: "#1D1347" },
    gradient: ["9B5DE5", "00BBF9", "F15BB5"], radius: 34, transition: "bands", subAnim: "drop", bullet: "dot", flip: true, sfx: 3, frame: "white", hueSpeed: 40, energy: "normal", subsDy: 20 },
  { id: "crimson", palette: { accent: "#E63946", cyan: "#FFADAD", gold: "#FFD166", dark: "#14080B", card: "#2B1015" },
    gradient: ["E63946", "9D0208", "F48C06"], radius: 22, transition: "wipe", subAnim: "pop", bullet: "square", progress: "top", sfx: 1, frame: "accent", pill: "square", hueSpeed: 10, sat: 1.4, tilt: false },
  { id: "ocean", palette: { accent: "#118AB2", cyan: "#06D6A0", gold: "#FFD166", dark: "#07202B", card: "#0D3445" },
    gradient: ["118AB2", "06D6A0", "073B4C"], radius: 30, transition: "flash2", subAnim: "slide", bullet: "arrow", flip: true, sfx: 2, frame: "gold", hueSpeed: 18, subsDy: -16 },
  { id: "mono-gold", palette: { accent: "#C9A227", cyan: "#EDEDED", gold: "#FFD700", dark: "#0D0D0D", card: "#1A1A1A" },
    gradient: ["C9A227", "3A3A3A", "8C6D1F"], radius: 16, transition: "bands", subAnim: "pop", bullet: "square", sfx: 0, frame: "gold", pill: "square", hueSpeed: 6, sat: 1.1, energy: "normal", tilt: false, progress: "top" },
  { id: "candy", palette: { accent: "#FF4D9D", cyan: "#5CE1E6", gold: "#FFF275", dark: "#1A0B24", card: "#2A1338" },
    gradient: ["FF4D9D", "5CE1E6", "B388EB"], radius: 44, transition: "flash2", subAnim: "drop", bullet: "dot", flip: true, sfx: 3, frame: "accent", hueSpeed: 36, subsDy: 24 },
].map((p) => ({ ...base, ...p }));

export const channelOf = (lang) => (lang === "ar" ? "ar" : "fr"); // FR/EN/IT = chaîne FR ; AR = chaîne arabe

// Choisit un thème pour une chaîne, en évitant les `avoid` derniers utilisés sur CETTE chaîne.
export function pickStyle({ channel, history = {}, avoid = 3, force = null, rng = Math.random }) {
  if (force) {
    const f = PRESETS.find((p) => p.id === force);
    if (f) return f;
  }
  const recent = (history[channel] || []).slice(-Math.min(avoid, PRESETS.length - 1));
  const pool = PRESETS.filter((p) => !recent.includes(p.id));
  return pool[Math.floor(rng() * pool.length)] || PRESETS[0];
}

// Petites variations propres à CHAQUE vidéo (même thème ≠ rendu identique)
export function microVariation(rng = Math.random) {
  const r = (a, b) => a + (b - a) * rng();
  return {
    hueOffset: Math.round(r(0, 360)),
    subsScale: +r(0.95, 1.06).toFixed(3),
    flareScale: +r(0.8, 1.25).toFixed(2),
    bgDark: +r(-0.24, -0.16).toFixed(2),
    gradSpeed: +r(0.02, 0.045).toFixed(3),
  };
}
