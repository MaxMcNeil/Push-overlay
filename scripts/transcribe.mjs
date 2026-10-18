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
// Modèles locaux par ordre de préférence : le plus précis disponible (large-v3-turbo comprend bien mieux l'arabe dialectal que small).
const WHISPER_MODELS = ["ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-small.bin"].map((m) => `whisper.cpp/models/${m}`);
const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";
const LANG_MAP = { arabic: "ar", french: "fr", english: "en", italian: "it" };

// Transcription en ligne GRATUITE via Groq (Whisper large-v3, mots horodatés) si GROQ_API_KEY existe.
async function viaGroq(video) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const mp3 = path.join(CONTENT_DIR, "audio-asr.mp3");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3], { stdio: ["ignore", "ignore", "ignore"] });
    const buf = readFileSync(mp3);
    if (buf.length > 24 * 1024 * 1024) throw new Error("audio trop gros pour l'envoi (> 24 Mo)");
    for (let attempt = 0; attempt < 3; attempt++) {
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
      fd.append("model", process.env.GROQ_ASR_MODEL || "whisper-large-v3");
      fd.append("response_format", "verbose_json");
      fd.append("timestamp_granularities[]", "word");
      fd.append("temperature", "0");
      if (process.env.ASR_LANGUAGE) fd.append("language", process.env.ASR_LANGUAGE);
      const res = await fetch(`${GROQ_BASE}/openai/v1/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (res.status === 429) {
        const wait = Math.min(60, Number(res.headers.get("retry-after")) || 20 * (attempt + 1));
        console.log(`  Groq (transcription) : limite atteinte, pause ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 300)}`);
      const j = await res.json();
      const words = (j.words || []).map((w) => ({ t0: Number(w.start), t1: Number(w.end), w: String(w.word || "").trim() })).filter((w) => w.w && isFinite(w.t0));
      if (!words.length) throw new Error("aucun mot horodaté dans la réponse");
      const l = String(j.language || "").toLowerCase();
      return { lang: normLang(LANG_MAP[l] || l), words };
    }
    throw new Error("limite de débit persistante");
  } catch (e) {
    console.log(`Transcription Groq indisponible (${e.message}) — repli sur whisper local.`);
    return null;
  }
}

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

async function main() {
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
  const groq = await viaGroq(video);
  if (groq) {
    writeFileSync(OUT_JSON, JSON.stringify({ lang: groq.lang, duration: info.duration, words: groq.words }, null, 1));
    writeFileSync(OUT_TXT, groq.words.map((x) => x.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1") + "\n");
    console.log(`Transcription Groq (Whisper large-v3) : ${groq.words.length} mots, langue ${groq.lang}.`);
    return;
  }
  const WHISPER_MODEL = WHISPER_MODELS.find((m) => existsSync(m));
  if (!existsSync(WHISPER_BIN) || !WHISPER_MODEL) {
    throw new Error("whisper.cpp ou son modèle est introuvable (voir le workflow).");
  }
  console.log(`Modèle whisper local : ${path.basename(WHISPER_MODEL)}`);

  const wav = path.join(CONTENT_DIR, "audio.wav");
  console.log("Extraction audio (mono 16 kHz)...");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "inherit" });

  console.log("Transcription whisper.cpp (langue auto, mot à mot)...");
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

await main();
