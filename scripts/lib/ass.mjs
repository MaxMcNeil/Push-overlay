// scripts/lib/ass.mjs — mini-bibliothèque pour fabriquer des sous-titres/animations ASS
import { fmtAssTime } from "./util.mjs";

export const PALETTE = {
  accent: "#FF2E63", cyan: "#08D9D6", gold: "#FFD23F", dark: "#0B0F2B", card: "#141A3D", white: "#FFFFFF", black: "#000000",
};

// "#RRGGBB" -> "&HBBGGRR&"  (la transparence se règle avec \\1a / \\3a / \\4a, jamais dans la couleur)
export function col(hex) {
  const h = hex.replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
export const alphaTag = (opacity) => `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, "0").toUpperCase()}&`;
// tags complets couleur + opacité (1 = opaque)
export const c1 = (hex, op = 1) => `\\1c${col(hex)}\\1a${alphaTag(op)}`;
export const c3 = (hex, op = 1) => `\\3c${col(hex)}\\3a${alphaTag(op)}`;
export const c4 = (hex, op = 1) => `\\4c${col(hex)}\\4a${alphaTag(op)}`;

export function esc(t) {
  return String(t).replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, " ");
}

// Rectangle arrondi (dessin ASS, origine en haut à gauche)
export function rrect(w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.45; // approximation de quart de cercle par bézier
  const f = (n) => Math.round(n * 10) / 10;
  return [
    `m ${f(r)} 0`, `l ${f(w - r)} 0`, `b ${f(w - k)} 0 ${f(w)} ${f(k)} ${f(w)} ${f(r)}`,
    `l ${f(w)} ${f(h - r)}`, `b ${f(w)} ${f(h - k)} ${f(w - k)} ${f(h)} ${f(w - r)} ${f(h)}`,
    `l ${f(r)} ${f(h)}`, `b ${f(k)} ${f(h)} 0 ${f(h - k)} 0 ${f(h - r)}`,
    `l 0 ${f(r)}`, `b 0 ${f(k)} ${f(k)} 0 ${f(r)} 0`,
  ].join(" ");
}

export function wrapText(text, maxChars, maxLines = 99) {
  const words = esc(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length > maxLines ? null : lines;
}

export class Ass {
  constructor(W, H, font, bold) {
    this.W = W; this.H = H; this.font = font; this.bold = bold; this.events = [];
  }
  add(layer, t0, t1, text) {
    if (t1 - t0 < 0.02) return;
    this.events.push({ layer, t0, t1, text });
  }
  // forme dessinée
  shape(layer, t0, t1, x, y, path, tags = "") {
    this.add(layer, t0, t1, `{\\an7\\pos(${Math.round(x)},${Math.round(y)})\\bord0\\shad0\\blur0${tags}\\p1}${path}{\\p0}`);
  }
  // texte (an = alignement numpad)
  text(layer, t0, t1, x, y, an, str, size, tags = "") {
    this.add(layer, t0, t1, `{\\an${an}\\pos(${Math.round(x)},${Math.round(y)})\\fs${size}${tags}}${str}`);
  }
  toString() {
    const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${this.W}
PlayResY: ${this.H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${this.font},60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,${this.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const sorted = [...this.events].sort((a, b) => a.layer - b.layer || a.t0 - b.t0);
    return head + sorted.map((e) => `Dialogue: ${e.layer},${fmtAssTime(e.t0)},${fmtAssTime(e.t1)},Default,,0,0,0,,${e.text}`).join("\n") + "\n";
  }
}
