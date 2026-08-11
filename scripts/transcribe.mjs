// scripts/transcribe.mjs
// Transcrit input/video.* en texte, 100% local. Appelle directement le binaire
// whisper-cli (compilé par le workflow via CMake, voir .github/workflows/build-overlay.yml)
// plutôt que le wrapper npm "nodejs-whisper", qui est cassé avec les versions récentes
// de whisper.cpp (celui-ci ne produit plus de binaire "main", et le wrapper échoue avec
// "'make' command failed" même quand la compilation a réellement réussi).
// Aucune clé API, aucun service payant : tout tourne en local sur le runner.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

const INPUT_DIR = "input";
const CONTENT_DIR = "content";
const OUT_TXT = path.join(CONTENT_DIR, "script.txt");

const WHISPER_BIN = "whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL = "whisper.cpp/models/ggml-base.bin";

function hasUsableScript() {
  if (!existsSync(OUT_TXT)) return false;
  // Un fichier vide (ou juste des espaces/retours à la ligne) ne compte pas
  // comme "texte fourni" — sinon la transcription serait sautée à tort.
  const content = readFileSync(OUT_TXT, "utf8").trim();
  return content.length > 0;
}

function findVideo() {
  const candidates = ["video.mp4", "video.mov", "video.mkv", "video.webm"];
  for (const c of candidates) {
    const p = path.join(INPUT_DIR, c);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Aucune vidéo trouvée dans ${INPUT_DIR}/ (attendu: video.mp4 / .mov / .mkv / .webm)`
  );
}

function main() {
  if (hasUsableScript()) {
    console.log(`content/script.txt existe déjà et contient du texte — transcription sautée.`);
    return;
  }
  if (existsSync(OUT_TXT)) {
    console.log(`content/script.txt existe mais est vide — transcription automatique lancée.`);
  }

  const videoPath = findVideo();
  console.log(`Vidéo détectée: ${videoPath}`);

  const wavPath = path.join(CONTENT_DIR, "audio.wav");
  mkdirSync(CONTENT_DIR, { recursive: true });

  console.log("Extraction audio (ffmpeg, mono 16kHz)...");
  execFileSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    { stdio: "inherit" }
  );

  if (!existsSync(WHISPER_BIN)) {
    throw new Error(
      `${WHISPER_BIN} introuvable. whisper.cpp doit être compilé avant cette étape (voir le workflow).`
    );
  }
  if (!existsSync(WHISPER_MODEL)) {
    throw new Error(
      `${WHISPER_MODEL} introuvable. Le modèle doit être téléchargé avant cette étape (voir le workflow).`
    );
  }

  console.log("Transcription locale (whisper.cpp, modèle 'base', langue auto-détectée)...");
  const outBase = path.resolve(CONTENT_DIR, "whisper-output");
  execFileSync(
    WHISPER_BIN,
    [
      "-m", WHISPER_MODEL,
      "-f", path.resolve(wavPath),
      "-l", "auto",
      "-otxt",
      "-of", outBase,
    ],
    { stdio: "inherit" }
  );

  const txtPath = outBase + ".txt";
  if (!existsSync(txtPath)) {
    throw new Error(`whisper-cli n'a produit aucun fichier de sortie (${txtPath} attendu).`);
  }

  const text = readFileSync(txtPath, "utf8");
  writeFileSync(OUT_TXT, text.trim() + "\n", "utf8");
  console.log(`Transcript écrit dans ${OUT_TXT} (${text.length} caractères).`);
}

main();
