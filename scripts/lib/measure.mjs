// scripts/lib/measure.mjs — mesure EXACTE des mots avec le moteur qui dessine le texte (libass).
// On affiche chaque mot dans une image noire puis le filtre ffmpeg "bbox" donne sa largeur réelle
// (formes arabes liées, crénage, police réelle…). Un seul appel ffmpeg pour tous les mots.
import { writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { fmtAssTime } from "./util.mjs";

const esc = (t) => String(t).replace(/[{}]/g, "").replace(/\\/g, "/");

export function measureTokens({ tokens, font, dir = "content" }) {
  const uniq = [...new Set(["|", "| |", ...tokens])];
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 4000
PlayResY: 200
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font.name},100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${font.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const body = uniq
    .map((t, i) => `Dialogue: 0,${fmtAssTime(i)},${fmtAssTime(i + 0.9)},Default,,0,0,0,,{\\an4\\pos(30,100)\\bord0\\shad0\\1c&HFFFFFF&}${esc(t)}`)
    .join("\n");
  const file = `${dir}/measure.ass`;
  writeFileSync(file, head + body + "\n");
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-v", "info", "-f", "lavfi", "-i", `color=c=black:s=4000x200:r=1:d=${uniq.length}`, "-vf", `ass=${file}:fontsdir=fonts,bbox`, "-f", "null", "-"],
    { maxBuffer: 1 << 28 }
  );
  const log = (r.stderr || "").toString();
  const w = new Map();
  for (const m of log.matchAll(/bbox[^\n]*?\bn:(\d+)\b[^\n]*?x1:(\d+) x2:(\d+)/g)) {
    const t = uniq[Number(m[1])];
    if (t !== undefined) w.set(t, Number(m[3]) - Number(m[2]) + 1);
  }
  let space = (w.get("| |") || 0) - 2 * (w.get("|") || 0);
  if (!(space > 5 && space < 80)) space = 26;
  let sumW = 0, sumC = 0;
  for (const [t, v] of w) { if (t.length > 1) { sumW += v; sumC += t.length; } }
  const avg = sumC ? sumW / sumC : 55;
  return { w, space, avg, ok: w.size > uniq.length * 0.5 };
}

// Largeur EXACTE d'une ligne entière à sa taille réelle (le crénage/hinting varie un peu avec la taille).
export function measureLine({ text, fs, font, dir = "content" }) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 16000
PlayResY: 120
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font.name},${fs},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${font.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:00.90,Default,,0,0,0,,{\\an4\\pos(30,60)\\bord0\\shad0\\1c&HFFFFFF&}${esc(text)}
`;
  const file = `${dir}/measure-line.ass`;
  writeFileSync(file, head);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "info", "-f", "lavfi", "-i", "color=c=black:s=16000x120:r=1:d=1", "-vf", `ass=${file}:fontsdir=fonts,bbox`, "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const m = (r.stderr || "").toString().match(/bbox[^\n]*?x1:(\d+) x2:(\d+)/);
  return m ? Number(m[2]) - Number(m[1]) + 1 : null;
}
