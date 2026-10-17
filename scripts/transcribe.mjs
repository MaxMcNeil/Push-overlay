// scripts/transcribe.mjs
// Transcrit input/video.* en texte AVEC horodatage mot à mot, 100 % local
// (whisper.cpp compilé par le workflow). Produit :
//   content/transcript.json  -> { lang, duration, words:[{t0,t1,w}] }  (sert au montage)
//   content/script.txt       -> texte brut (sert à l'écriture des headlines)
// Si content/script.txt existe déjà (texte fourni par toi), il est conservé :
// le texte vient de toi, mais les horaires viennent quand même de la vidéo si
// elle est présente (sinon ils sont répartis régulièrement sur la durée).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { CONTENT_DIR, findVideo, probeVideo, detectLanguage, normLang } from "./lib/util.mjs";

const OUT_TXT = path.join(CONTENT_DIR, "script.txt");
const OUT_JSON = path.join(CONTENT_DIR, "transcript.json");
const WHISPER_BIN = "whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL = "whisper.cpp/models/ggml-small.bin";

function hasUsableScript() {
  return existsSync(OUT_TXT) && readFileSync(OUT_TXT, "utf8").trim().length > 0;
}

function parseOffsetMs(seg, key) {
  if (seg.offsets && seg.offsets[key] !== undefined) return seg.offsets[key];
  const ts = seg.timestamps && seg.timestamps[key];
  if (!ts) return 0;
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] : 0;
}

function evenlySpread(text, duration) {
  const ws = text.split(/\s+/).filter(Boolean);
  const step = duration / Math.max(1, ws.length);
  return ws.map((w, i) => ({ t0: i * step, t1: (i + 1) * step * 0.95, w }));
}

function main() {
  mkdirSync(CONTENT_DIR, { recursive: true });
  const video = findVideo();
  if (!video) throw new Error("Aucune vidéo dans input/ (video.mp4/.mov/.mkv/.webm).");
  const info = probeVideo(video);
  console.log(`Vidéo ${video}: ${info.width}x${info.height}, ${info.duration.toFixed(1)} s`);

  if (hasUsableScript()) {
    const text = readFileSync(OUT_TXT, "utf8").trim();
    const lang = detectLanguage(text);
    writeFileSync(OUT_JSON, JSON.stringify({ lang, duration: info.duration, words: evenlySpread(text, info.duration) }, null, 1));
    console.log(`content/script.txt fourni (${lang}) — transcription sautée, horaires répartis sur ${info.duration.toFixed(0)} s.`);
    return;
  }

  if (!info.hasAudio) throw new Error("La vidéo n'a pas de piste audio : rien à transcrire. Fournis content/script.txt.");
  if (!existsSync(WHISPER_BIN) || !existsSync(WHISPER_MODEL)) {
    throw new Error("whisper.cpp ou son modèle est introuvable (voir le workflow).");
  }

  const wav = path.join(CONTENT_DIR, "audio.wav");
  console.log("Extraction audio (mono 16 kHz)...");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "inherit" });

  console.log("Transcription whisper.cpp (modèle small, langue auto, mot à mot)...");
  const outBase = path.resolve(CONTENT_DIR, "whisper-output");
  execFileSync(
    WHISPER_BIN,
    ["-m", WHISPER_MODEL, "-f", path.resolve(wav), "-l", "auto", "-ml", "1", "-sow", "-oj", "-of", outBase],
    { stdio: "inherit" }
  );
  const j = JSON.parse(readFileSync(outBase + ".json", "utf8"));
  const lang = normLang(j.result && j.result.language);
  const words = [];
  for (const seg of j.transcription || []) {
    const w = (seg.text || "").trim();
    if (!w || /^\[.*\]$/.test(w) || /^\(.*\)$/.test(w)) continue; // [MUSIC], (rires)...
    words.push({ t0: parseOffsetMs(seg, "from") / 1000, t1: parseOffsetMs(seg, "to") / 1000, w });
  }
  if (words.length === 0) throw new Error("Aucune parole détectée dans la vidéo.");
  writeFileSync(OUT_JSON, JSON.stringify({ lang, duration: info.duration, words }, null, 1));
  writeFileSync(OUT_TXT, words.map((x) => x.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1") + "\n");
  console.log(`${words.length} mots, langue détectée : ${lang}.`);
}

main();
