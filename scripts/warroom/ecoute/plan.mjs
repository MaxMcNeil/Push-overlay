// War Room — 📻 Radios et émissions, étape 1 : trouver les flux podcast du catalogue, garder le dernier épisode des 36 h,
// et répartir l'écoute sur plusieurs machines (au plus 60 min d'audio chacune, 40 min max par épisode : le début d'une
// émission porte ses sujets forts). Rien de payant, aucune clé : annuaire public des podcasts + flux RSS des médias.
// Sortie : output/warroom/ecoute/plan.json, et « matrice » / « plan » pour GitHub Actions.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";

const OUT = "output/warroom/ecoute";
const FENETRE_H = Number(process.env.ECOUTE_FENETRE_H || 36);
const MIN_EP = Number(process.env.ECOUTE_MIN_EPISODE || 40);       // minutes écoutées au plus par épisode
const MIN_MACHINE = Number(process.env.ECOUTE_MIN_MACHINE || 60);  // minutes d'audio par machine
const MACHINES = Math.min(20, Number(process.env.ECOUTE_MACHINES || 12));
const LANGUES = String(process.env.ECOUTE_LANGUES || "fr,en,ar").split(/[,\s]+/).filter(Boolean);
const log = (...a) => console.log(...a);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const plat = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const txt = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")) || [])[1] || "";

async function get(url, { json = false, timeout = 25000 } = {}) {
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (WarRoom podcast reader)" }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
      if (r.ok) return json ? await r.json() : await r.text();
      if (r.status === 404 || r.status === 403) return null;
    } catch {}
    await dormir(1500);
  }
  return null;
}

export function lireCatalogue() {
  const src = readFileSync(new URL("./catalogue.md", import.meta.url), "utf8");
  const L = src.split("\n").map((l) => l.match(/^-\s*(fr|en|ar)\s*:\s*(.+?)\s*(?:=\s*(https?:\/\/\S+))?\s*$/i)).filter(Boolean)
    .map((m) => ({ langue: m[1].toLowerCase(), nom: m[2].trim(), flux: m[3] || "" }));
  // ajouts libres du workflow : « nom », « langue : nom » ou une adresse de flux, séparés par retour à la ligne, « ; » ou « , »
  for (const x of String(process.env.ECOUTE_PLUS || "").split(/[\n;,]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = x.match(/^(fr|en|ar)\s*:\s*(.+)$/i);
    const nom = m ? m[2].trim() : x, langue = m ? m[1].toLowerCase() : /[؀-ۿ]/.test(x) ? "ar" : "";
    L.push(/^https?:\/\//.test(nom) ? { langue: langue || "fr", nom: nom.replace(/^https?:\/\/(www\.)?/, "").split("/")[0], flux: nom } : { langue, nom, flux: "" });
  }
  return L.filter((x) => !x.langue || LANGUES.includes(x.langue));
}

// annuaire public des podcasts (Apple, sans clé) : le flux dont le nom colle le mieux, le plus récemment mis à jour
async function trouverFlux(c) {
  const mots = plat(c.nom).split(" ").filter((w) => w.length >= 2);
  const pays = { fr: ["FR", "US"], en: ["US", "GB"], ar: ["SA", "AE", "US"] }[c.langue] || ["FR", "US"];
  let best = null;
  for (const p of pays) {
    const j = await get(`https://itunes.apple.com/search?media=podcast&limit=15&country=${p}&term=${encodeURIComponent(c.nom)}`, { json: true });
    for (const r of j?.results || []) {
      if (!r.feedUrl) continue;
      const nom = plat(`${r.collectionName} ${r.artistName}`);
      const sc = mots.length ? mots.filter((w) => nom.split(" ").includes(w) || nom.includes(w)).length / mots.length : 0;
      if (sc < 0.75) continue;
      const t = Date.parse(r.releaseDate || 0) || 0;
      if (!best || sc > best.sc || (sc === best.sc && t > best.t)) best = { sc, t, flux: r.feedUrl, titre: r.collectionName, auteur: r.artistName };
    }
    if (best?.sc === 1) break;
    await dormir(800);
  }
  return best;
}

const duree = (s) => { s = String(s || "").trim(); if (!s) return 0; if (/^\d+$/.test(s)) return Number(s) / 60; const p = s.split(":").map(Number); return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 60 : p.length === 2 ? p[0] + p[1] / 60 : 0; };

async function dernierEpisode(c, flux) {
  const x = await get(flux, { timeout: 30000 });
  if (!x) return { raison: "flux injoignable" };
  const items = x.split(/<item[\s>]/).slice(1, 30);
  let vu = 0;
  for (const it of items) {
    const date = Date.parse(txt(tag(it, "pubDate")) || txt(tag(it, "dc:date")));
    const audio = (it.match(/<enclosure[^>]*url=["']([^"']+)["']/i) || [])[1];
    if (!audio || !isFinite(date)) continue;
    vu++;
    if (Date.now() - date > FENETRE_H * 3600e3) return { raison: `dernier épisode trop ancien (${new Date(date).toISOString().slice(0, 10)})` };
    return { ep: { nom: c.nom, media: txt(tag(x.split(/<item[\s>]/)[0], "title")) || c.nom, langue: c.langue || "fr", titre: txt(tag(it, "title")).slice(0, 200),
      date: new Date(date).toISOString(), audio: audio.replace(/&amp;/g, "&"), lien: txt(tag(it, "link")) || "", minutes: Math.round(duree(txt(tag(it, "itunes:duration")))) || 0 } };
  }
  return { raison: vu ? "aucun épisode récent" : "aucun épisode audio dans le flux" };
}

export async function planifier() {
  mkdirSync(OUT, { recursive: true });
  const cat = lireCatalogue();
  const eps = [], sautes = [];
  for (const c of cat) {
    let flux = c.flux, info = "";
    if (!flux) {
      const f = await trouverFlux(c);
      if (!f) { sautes.push(`${c.nom} : introuvable dans l'annuaire des podcasts`); continue; }
      flux = f.flux; info = ` → « ${f.titre} » (${f.auteur})`;
      if (!c.langue) c.langue = "fr";
    }
    const r = await dernierEpisode(c, flux);
    if (!r.ep) { sautes.push(`${c.nom}${info} : ${r.raison}`); continue; }
    eps.push({ ...r.ep, flux });
    log(`  ✓ ${c.nom}${info} : « ${r.ep.titre.slice(0, 80)} » (${r.ep.date.slice(0, 16).replace("T", " ")}, ${r.ep.minutes || "?"} min)`);
  }
  for (const s of sautes) log(`  – ${s}`);
  // répartition : les plus récents d'abord, 40 min max par épisode, 60 min par machine, au plus MACHINES machines
  eps.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const lots = [];
  for (const e of eps) {
    const m = Math.min(MIN_EP, e.minutes || MIN_EP);
    let lot = lots.find((l) => l.minutes + m <= MIN_MACHINE);
    if (!lot && lots.length < MACHINES) lots.push((lot = { minutes: 0, eps: [] }));
    if (!lot) { log(`  (plafond d'écoute atteint : ${e.nom} non écouté)`); continue; }
    lot.minutes += m; lot.eps.push({ ...e, ecoute: m });
  }
  const plan = { date: new Date().toISOString(), episodes: eps.length, lots: lots.map((l) => l.eps) };
  writeFileSync(`${OUT}/plan.json`, JSON.stringify(plan, null, 1));
  log(`\nÉcoute : ${cat.length} médias au catalogue, ${eps.length} épisode(s) des ${FENETRE_H} dernières heures, ${lots.length} machine(s), ${lots.reduce((s, l) => s + l.minutes, 0)} min d'audio.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrice=${JSON.stringify(lots.map((_, i) => i))}\n`);
  return plan;
}

if (process.argv[1] && process.argv[1].endsWith("plan.mjs")) await planifier();
