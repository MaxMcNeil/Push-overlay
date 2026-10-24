// scripts/lib/short-styles.mjs — identités visuelles des SHORTS (volontairement sans rapport avec Build Video :
// pas de fenêtre néon, pas de bandeau, pas de ticker défilant, pas de cartes split-screen, pas de flashs).
// Chaque style change : couleurs, forme du mot actif des sous-titres (boîte / couleur / soulignement), étiquette de
// chapitre (inclinaison, forme), puces, effet de transition, sons.

const base = { caption: "box", upper: true, tagTilt: -2.5, tagShape: "block", chip: "light", glitch: "rgb", sfx: "a", vignette: true, push: 0.05, jump: 0.07 };

export const SHORT_STYLES = [
  { id: "pop-yellow", pal: { accent: "#FFE000", accentText: "#111111", text: "#FFFFFF", chipBg: "#FFFFFF", chipText: "#111111", dot: "#FF3B30" } },
  { id: "red-alert", pal: { accent: "#FF2D2D", accentText: "#FFFFFF", text: "#FFFFFF", chipBg: "#111111", chipText: "#FFFFFF", dot: "#FF2D2D" },
    caption: "color", tagTilt: 2, tagShape: "slant", chip: "dark", glitch: "shake", sfx: "b" },
  { id: "mint-news", pal: { accent: "#2DFFB3", accentText: "#06231A", text: "#FFFFFF", chipBg: "#F2FFF9", chipText: "#06231A", dot: "#00A86B" },
    caption: "underline", tagTilt: 0, tagShape: "pill", glitch: "rgb", sfx: "c", jump: 0.06 },
  { id: "electric", pal: { accent: "#3D7BFF", accentText: "#FFFFFF", text: "#FFFFFF", chipBg: "#0B1A3A", chipText: "#FFFFFF", dot: "#3D7BFF" },
    caption: "box", tagTilt: -1.5, tagShape: "pill", chip: "dark", glitch: "shake", sfx: "a", push: 0.04 },
  { id: "orange-cut", pal: { accent: "#FF7A00", accentText: "#FFFFFF", text: "#FFFFFF", chipBg: "#FFFFFF", chipText: "#1A1A1A", dot: "#FF7A00" },
    caption: "color", tagTilt: -3, tagShape: "block", glitch: "rgb", sfx: "b", jump: 0.08 },
  { id: "violet-mag", pal: { accent: "#B14DFF", accentText: "#FFFFFF", text: "#FFFFFF", chipBg: "#1B0B2E", chipText: "#FFFFFF", dot: "#E5B8FF" },
    caption: "underline", tagTilt: 1.5, tagShape: "slant", chip: "dark", glitch: "shake", sfx: "c", vignette: false },
].map((s) => ({ ...base, ...s }));

// Historique propre aux shorts (clé "<chaîne>-shorts") : un style ne revient pas avant plusieurs shorts.
export function pickShortStyles(n, history = [], rng = Math.random) {
  const out = [];
  const recent = [...history];
  for (let i = 0; i < n; i++) {
    const avoid = recent.slice(-Math.min(SHORT_STYLES.length - 1, 3 + i));
    const pool = SHORT_STYLES.filter((s) => !avoid.includes(s.id));
    const s = (pool.length ? pool : SHORT_STYLES)[Math.floor(rng() * (pool.length || SHORT_STYLES.length))];
    out.push(s.id);
    recent.push(s.id);
  }
  return out;
}
export const shortStyle = (id) => SHORT_STYLES.find((s) => s.id === id) || SHORT_STYLES[Math.floor(Math.random() * SHORT_STYLES.length)];
