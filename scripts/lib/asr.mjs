// scripts/lib/asr.mjs — transcription COURTE d'un extrait (début d'une vidéo déposée) via Groq Whisper, gratuite.
// Sert à reconnaître le contenu d'une vidéo (qui parle, de quoi) pour la relier à ce que dit la voix.
// Jamais bloquant : sans clé Groq, quota atteint ou erreur → "" (le contenu est alors jugé sur le nom du fichier).
import { execFileSync } from "child_process";
import { readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { groqKeys } from "./llm.mjs";

const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";

export async function transcribeStart(file, seconds = 40) {
  const keys = groqKeys();
  if (!keys.length) return "";
  const mp3 = path.join(os.tmpdir(), `asr-${process.pid}-${Math.random().toString(36).slice(2)}.mp3`);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-t", String(seconds), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3], { timeout: 120000 });
    const buf = readFileSync(mp3);
    for (const model of [process.env.GROQ_ASR_MODEL || "whisper-large-v3-turbo", "whisper-large-v3"]) {
      for (const key of keys) {
        const fd = new FormData();
        fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "clip.mp3");
        fd.append("model", model);
        fd.append("response_format", "json");
        fd.append("temperature", "0");
        const res = await fetch(`${GROQ_BASE}/openai/v1/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(90000) }).catch(() => null);
        if (!res) continue;
        if (res.ok) return String((await res.json()).text || "").replace(/\s+/g, " ").trim().slice(0, 600);
        const body = (await res.text()).slice(0, 200);
        if (res.status === 429) continue;                       // clé limitée : clé suivante
        if (/model/i.test(body)) break;                        // modèle retiré : modèle suivant
      }
    }
  } catch { /* vidéo sans son, ffmpeg en échec… : jugée sur son nom */ } finally { try { rmSync(mp3, { force: true }); } catch {} }
  return "";
}
