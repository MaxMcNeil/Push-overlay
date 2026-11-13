// scripts/explainer/clips-asr.mjs — transcrit (mots horodatés) le son de chaque vidéo jointe : input/clips/* →
// content/clips-asr.json { "<fichier>": { lang, words:[{t0,t1,w}], dur } }.
// Sert à choisir les passages (ouverture choc, « écoutez », rythme des extraits) et à les sous-titrer.
// Même moteur que la voix : Groq Whisper (gratuit) puis whisper.cpp local. Une vidéo sans son ou illisible est notée
// sans mots (elle reste utilisable en image). Jamais bloquant : une erreur sur une vidéo n'arrête pas les autres.
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { transcribeAll } from "../transcribe.mjs";

const DIR = "input/clips", OUT = "content/clips-asr.json";
const MAX_S = Number(process.env.EXPLAINER_CLIP_ASR_MAX_S || 1800);   // au-delà de 30 min, seul le début est transcrit (quota)
const probe = (f) => { try { const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]).toString());
  return { dur: Number(j.format.duration) || 0, audio: j.streams.some((s) => s.codec_type === "audio") }; } catch { return { dur: 0, audio: false }; } };

mkdirSync("content", { recursive: true });
const files = existsSync(DIR) ? readdirSync(DIR).filter((x) => /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(x)).sort() : [];
const out = {};
for (const f of files) {
  const p = path.join(DIR, f), info = probe(p);
  if (!info.audio || info.dur < 1.5) { out[f] = { lang: "", words: [], dur: info.dur, note: "sans son" }; console.log(`${f} : sans son (image seulement)`); continue; }
  let src = p;
  if (info.dur > MAX_S) { src = path.join("content", `clip-asr-${f}.m4a`); execFileSync("ffmpeg", ["-y", "-v", "error", "-i", p, "-t", String(MAX_S), "-vn", "-c:a", "aac", src]); }
  try {
    const r = await transcribeAll(src, Math.min(info.dur, MAX_S));
    out[f] = { lang: r.lang, words: r.words, dur: info.dur };
    console.log(`${f} : ${r.words.length} mots (${r.lang}, ${r.engine})${info.dur > MAX_S ? ` — ${Math.round(MAX_S / 60)} premières minutes` : ""}`);
  } catch (e) { out[f] = { lang: "", words: [], dur: info.dur, note: String(e.message).slice(0, 160) }; console.log(`⚠ ${f} : transcription impossible (${String(e.message).slice(0, 140)})`); }
}
writeFileSync(OUT, JSON.stringify(out));
console.log(`✔ ${OUT} : ${files.length} vidéo(s)`);
