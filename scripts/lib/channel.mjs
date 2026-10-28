// Chaîne selon la langue : logo + nom. Source unique : dossier chaines/ de Montage-LV-final (copié au lancement par
// l'action setup-media), sinon la copie locale chaines/, sinon l'ancien input/logo-<langue>.png.
// RÈGLE STRICTE : le logo d'une chaîne n'apparaît QUE sur une vidéo dans sa langue. Aucune chaîne pour la langue de la
// vidéo → AUCUN logo (jamais le logo français sur une vidéo arabe, italienne ou anglaise, et inversement).
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { execFileSync } from "child_process";

function profiles(root = "chaines") {
  if (!existsSync(root)) return [];
  const out = [];
  for (const code of readdirSync(root).sort()) {
    const d = `${root}/${code}`;
    if (code.startsWith(".") || code.startsWith("_") || !statSync(d).isDirectory()) continue;
    let j = {};
    try { j = JSON.parse(readFileSync(`${d}/chaine.json`, "utf8").replace(/^﻿/, "")); } catch { j = {}; }
    const langs = (Array.isArray(j.langues) ? j.langues : [j.langues || code]).map((x) => String(x).trim().toLowerCase().slice(0, 2));
    const cands = [j.logo ? `${d}/${j.logo}` : null, `${d}/logo.png`, `${d}/logo.webp`, `${d}/logo.jpg`].filter(Boolean);
    out.push({ code: code.toLowerCase(), nom: String(j.nom || "").trim(), langues: langs, logo: cands.find((f) => existsSync(f)) || null });
  }
  return out;
}

// logo lisible ? (fichier abîmé → pas de logo plutôt qu'un rendu qui échoue)
function readable(f) {
  try {
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", f], { timeout: 20000 });
    return true;
  } catch { return false; }
}

export function channelFor(lang) {
  const lg = String(lang || "").toLowerCase().slice(0, 2);
  const synced = process.env.CHAINES_DIR ? profiles(process.env.CHAINES_DIR) : [];
  const p = (synced.length ? synced : profiles()).find((x) => lg && x.langues.includes(lg));
  if (p && p.logo && readable(p.logo)) return { ...p, why: `chaîne « ${p.nom || p.code} » (langue ${lg})` };
  if (p && p.logo) return { ...p, logo: null, why: `⚠ logo de la chaîne « ${p.nom || p.code} » illisible : sans logo` };
  if (p) return { ...p, why: `chaîne « ${p.nom || p.code} » sans logo.png` };
  const legacy = lg ? `input/logo-${lg}.png` : null;          // ancien emplacement, même langue uniquement
  if (legacy && existsSync(legacy) && readable(legacy)) return { code: lg, nom: "", langues: [lg], logo: legacy, why: `logo ${legacy}` };
  return { code: "", nom: "", langues: [], logo: null, why: `aucune chaîne en « ${lg || "?"} » : sans logo (jamais celui d'une autre langue)` };
}

// Montage-LV-final écrit dans le fichier « logo=… » quand son petit logo est déjà incrusté
export function burnedLogo(videoPath) {
  try {
    const c = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", videoPath],
      { timeout: 20000 }).toString();
    const m = c.match(/montage-lv-final;logo=([a-z]+)-([a-z-]+);chaine=([a-z]*);langue=([a-z]*)/);
    return m ? { orient: m[1], pos: m[2], chaine: m[3], lang: m[4] } : null;
  } catch { return null; }
}
