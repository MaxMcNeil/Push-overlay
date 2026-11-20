// scripts/explainer/transcript-fourni.mjs — la voix arrive DÉJÀ transcrite (« voix-transcript.json » joint à la release,
// écrit par « Émission radio » qui connaît chaque mot de l'émission et son horaire) : on le reprend tel quel au lieu de
// re-transcrire (rapide, aucun quota Groq consommé, même pour une émission de plusieurs heures).
// Sortie 0 = transcription reprise (content/transcript.json + content/script.txt) ; 1 = rien de valable → transcription normale.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";

const F = "input/raw/voix-transcript.json";
try {
  if (!existsSync(F) || !existsSync("input/voice.wav")) process.exit(1);
  const j = JSON.parse(readFileSync(F, "utf8"));
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "input/voice.wav"]).toString().trim());
  const words = (Array.isArray(j.words) ? j.words : []).filter((w) => w && w.w && isFinite(w.t0) && isFinite(w.t1) && w.t1 >= w.t0 && w.t1 <= d + 1);
  // la transcription doit correspondre à CETTE voix : même durée (± 3 s) et assez de mots
  if (!isFinite(d) || Math.abs(d - Number(j.duration)) > 3 || words.length < Math.max(20, d / 30)) {
    console.log(`Transcription jointe ignorée (durée ${j.duration} s contre ${d.toFixed(1)} s, ${words.length} mots) : transcription normale.`);
    process.exit(1);
  }
  words.sort((a, b) => a.t0 - b.t0);
  mkdirSync("content", { recursive: true });
  writeFileSync("content/transcript.json", JSON.stringify({ lang: j.lang || "fr", duration: d, words }, null, 1));
  writeFileSync("content/script.txt", words.map((x) => x.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1") + "\n");
  // émission radio : qui parle quand → habillage « radio » de la vidéo (micro, téléphone, sonnerie)
  if (Array.isArray(j.segments) && j.segments.length) {
    const segments = j.segments.filter((x) => x && isFinite(x.t0) && isFinite(x.t1) && x.t1 > x.t0 && x.qui);
    writeFileSync("content/radio.json", JSON.stringify({ lang: j.lang || "fr", segments }));
    console.log(`Émission radio : ${segments.length} passages (animateur, auditeurs, sonneries) → habillage radio`);
  }
  console.log(`Transcription jointe reprise : ${words.length} mots, langue ${j.lang}, ${(d / 60).toFixed(1)} min — rien à re-transcrire.`);
  process.exit(0);
} catch (e) {
  console.log(`Transcription jointe illisible (${e.message}) : transcription normale.`);
  process.exit(1);
}
