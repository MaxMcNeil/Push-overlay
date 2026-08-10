// scripts/generate-overlay.mjs
// 1. Détecte l'orientation de input/video.* via ffprobe (horizontal ou vertical)
// 2. Charge le bon template (templates/overlay-horizontal.html ou -vertical.html)
// 3. Injecte le logo (input/logo.png, en base64) et les accroches (content/highlights.json)
// 4. Écrit docs/index.html — c'est CETTE page que tu mets en Browser Source dans OBS
//    (via l'URL GitHub Pages du dépôt).

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { detectLanguage } from "./extract-highlights.mjs";

const CONFIG = {
  channelLine1: "LE JOURNAL",
  channelLine2: "DU NON",
  subtitle: "Enquête · Actualité en direct",
  location: "EN DIRECT",
  intervalMs: 8000,
};

function findVideo() {
  const candidates = ["video.mp4", "video.mov", "video.mkv", "video.webm"];
  for (const c of candidates) {
    const p = path.join("input", c);
    if (existsSync(p)) return p;
  }
  return null;
}

function detectOrientation() {
  // Priorité 1 : forçage manuel via content/orientation.txt ("horizontal" ou "vertical").
  // Utile quand tu fournis juste un texte, sans vidéo de référence.
  const forcePath = "content/orientation.txt";
  if (existsSync(forcePath)) {
    const forced = readFileSync(forcePath, "utf8").trim().toLowerCase();
    if (forced === "horizontal" || forced === "vertical") {
      console.log(`Orientation forcée via ${forcePath}: ${forced}`);
      return forced;
    }
    console.warn(`${forcePath} contient une valeur invalide ("${forced}") — ignoré.`);
  }

  // Priorité 2 : détection depuis la vidéo si elle est présente (téléchargée
  // depuis une Release GitHub par le workflow, voir README).
  const video = findVideo();
  if (!video) {
    console.warn("Aucune vidéo trouvée et pas de content/orientation.txt — format horizontal par défaut.");
    return "horizontal";
  }
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${video}"`
    )
      .toString()
      .trim();
    const [w, h] = out.split(",").map(Number);
    console.log(`Vidéo ${video}: ${w}x${h}`);
    return h > w ? "vertical" : "horizontal";
  } catch (e) {
    console.warn("ffprobe a échoué, format horizontal par défaut.", e.message);
    return "horizontal";
  }
}

// Logo par langue : dépose input/logo-fr.png ET input/logo-ar.png une bonne
// fois pour toutes, et ce script choisit automatiquement le bon selon la
// langue détectée dans les accroches générées — jamais besoin d'écraser un
// fichier au risque de casser l'autre chaîne. input/logo.png reste un
// repli si aucun fichier spécifique à la langue n'existe (rétrocompatible
// avec un dépôt qui n'a encore qu'un seul logo).
function loadLogoBase64(lang) {
  const candidates = [`input/logo-${lang}.png`, "input/logo.png"];
  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`Logo utilisé: ${p}`);
      return readFileSync(p).toString("base64");
    }
  }
  console.warn(`Aucun logo trouvé (${candidates.join(", ")}) — le badge logo sera vide.`);
  return "";
}

function loadItems() {
  const p = "content/highlights.json";
  if (!existsSync(p)) {
    console.warn("content/highlights.json introuvable — aucune accroche générée.");
    return [];
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function main() {
  const orientation = detectOrientation();
  const templatePath = `templates/overlay-${orientation}.html`;
  console.log(`Orientation retenue: ${orientation} -> ${templatePath}`);

  let html = readFileSync(templatePath, "utf8");
  const items = loadItems();
  // Langue détectée depuis les accroches déjà générées (pas depuis
  // content/script.txt directement) : ça marche quel que soit le chemin
  // emprunté en amont — LLM, repli heuristique, ou manual-headlines.txt.
  const lang = detectLanguage(items.map((it) => it.t).join(" "));
  const logoB64 = loadLogoBase64(lang);

  html = html
    .replaceAll("__LOGO_B64__", logoB64)
    .replaceAll("__ITEMS_JSON__", JSON.stringify(items))
    .replaceAll("__CHANNEL_LINE1__", CONFIG.channelLine1)
    .replaceAll("__CHANNEL_LINE2__", CONFIG.channelLine2)
    .replaceAll("__SUBTITLE__", CONFIG.subtitle)
    .replaceAll("__LOCATION__", CONFIG.location)
    .replaceAll("__INTERVAL_MS__", String(CONFIG.intervalMs));

  writeFileSync("docs/index.html", html, "utf8");
  console.log(`docs/index.html généré (${(html.length / 1024).toFixed(1)} Ko).`);
}

main();
