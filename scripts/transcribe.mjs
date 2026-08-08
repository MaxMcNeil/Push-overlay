// scripts/transcribe.mjs
// Transcrit input/video.* en texte, 100% local (whisper.cpp via le package "nodejs-whisper").
// Aucune clé API, aucun service payant : le modèle est téléchargé une seule fois et tourne en local
// sur le runner GitHub Actions (CPU). Si content/script.txt existe déjà, ce script est sauté
// (voir .github/workflows/build-overlay.yml).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const INPUT_DIR = "input";
const CONTENT_DIR = "content";
const OUT_TXT = path.join(CONTENT_DIR, "script.txt");

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

async function main() {
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
  execSync(
    `ffmpeg -y -i "${videoPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`,
    { stdio: "inherit" }
  );

  console.log("Transcription locale (whisper.cpp, modèle 'base', FR)...");
  // nodejs-whisper télécharge le binaire whisper.cpp + le modèle GGML au premier lancement
  // et les met en cache ensuite (voir workflow: cache de node_modules/nodejs-whisper).
  const { nodewhisper } = await import("nodejs-whisper");
  const result = await nodewhisper(wavPath, {
    modelName: "base",
    autoDownloadModelName: "base",
    whisperOptions: {
      outputInText: true,
      language: "fr",
    },
  });

  const text = typeof result === "string" ? result : JSON.stringify(result);
  writeFileSync(OUT_TXT, text.trim() + "\n", "utf8");
  console.log(`Transcript écrit dans ${OUT_TXT} (${text.length} caractères).`);
}

main().catch((err) => {
  console.error("Erreur de transcription:", err);
  process.exit(1);
});
