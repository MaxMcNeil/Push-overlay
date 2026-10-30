// scripts/pick-style.mjs — choisit le thème de CETTE vidéo et mémorise l'historique par chaîne.
// Écrit content/theme.json (lu par render-video.mjs) et met à jour state/style-history.json.
// Forcer un thème : content/style.json {"style":"sunset"} ou variable STYLE_ID. Désactiver : {"style":"default"}.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { PRESETS, channelOf, pickStyle, microVariation } from "./lib/styles.mjs";

const PLAN = "content/plan.json";
const HIST = "state/style-history.json";
mkdirSync("state", { recursive: true });
const plan = existsSync(PLAN) ? JSON.parse(readFileSync(PLAN, "utf8")) : { lang: "fr" };
const channel = channelOf(plan.lang);
const history = existsSync(HIST) ? JSON.parse(readFileSync(HIST, "utf8")) : {};
let st = {};
try { st = existsSync("content/style.json") ? JSON.parse(readFileSync("content/style.json", "utf8")) : {}; }
catch (e) { console.log(`⚠ content/style.json illisible (${e.message}) : ignoré.`); }
let force = process.env.STYLE_ID || st.style || null;
if (force && force !== "default" && force !== "off" && !PRESETS.some((p) => p.id === force)) {
  console.log(`⚠ Thème « ${force} » inconnu (thèmes : ${PRESETS.map((p) => p.id).join(", ")}) : choix automatique.`);
  force = null;
}

let theme;
if (force === "default" || force === "off") {
  theme = { ...PRESETS[0], id: "neon-night" };
  console.log("Thème forcé : rendu d'origine (neon-night), sans variation.");
} else {
  // plusieurs vidéos montées en même temps (même release) : même graine pour le lot, un style DIFFÉRENT par vidéo
  const seed = process.env.BATCH_SEED, idx = Number(process.env.BATCH_INDEX || 0);
  if (!force && seed && idx > 0) {
    let h = 2166136261;
    for (const ch of `${seed}|${channel}`) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0), (h >>> 0) / 4294967296);
    const recent = (history[channel] || []).slice(-Math.min(3, PRESETS.length - 1));
    const pool = PRESETS.filter((p) => !recent.includes(p.id));
    const order = (pool.length >= idx ? pool : PRESETS).map((p) => [rnd(), p]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    theme = order[(idx - 1) % order.length];
    console.log(`Lot de vidéos : vidéo n° ${idx} → style ${theme.id} (différent des autres vidéos du lot)`);
  } else theme = pickStyle({ channel, history, avoid: 3, force });
  theme = { ...theme, micro: microVariation() };
}
writeFileSync("content/theme.json", JSON.stringify(theme, null, 2));
writeFileSync("content/style-pick.json", JSON.stringify({ channel, id: theme.id }));   // mémorisé en fin de lot
if (!force && !process.env.NO_STYLE_HISTORY) {
  history[channel] = [...(history[channel] || []), theme.id].slice(-12);
  writeFileSync(HIST, JSON.stringify(history, null, 2) + "\n");
}
console.log(`Thème choisi pour la chaîne « ${channel} » : ${theme.id} (historique : ${(history[channel] || []).join(" → ")})`);
