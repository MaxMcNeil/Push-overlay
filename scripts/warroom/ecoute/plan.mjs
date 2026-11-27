// War Room — 📻 Radios et émissions, étape 1 : trouver les flux podcast du catalogue, garder le dernier épisode des 36 h,
// et répartir l'écoute sur plusieurs machines (au plus 90 min d'audio chacune, 45 min max par épisode : le début d'une
// émission porte ses sujets forts). Rien de payant, aucune clé : annuaire public des podcasts + flux RSS des médias.
// Sortie : output/warroom/ecoute/plan.json, et « matrice » / « plan » pour GitHub Actions.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";

const OUT = "output/warroom/ecoute";
const FENETRE_H = Number(process.env.ECOUTE_FENETRE_H || 72);   // les émissions indépendantes sortent souvent 2-3 fois par semaine
const MIN_EP = Number(process.env.ECOUTE_MIN_EPISODE || 45);       // minutes écoutées au plus par épisode
const MIN_MACHINE = Number(process.env.ECOUTE_MIN_MACHINE || 90);  // minutes d'audio par machine
const MACHINES = Math.min(20, Number(process.env.ECOUTE_MACHINES || 20));
const MIN_DIRECT = Number(process.env.ECOUTE_MIN_DIRECT || 20);  // minutes enregistrées en direct sur une radio
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
  const L = src.split("\n").map((l) => l.match(/^-\s*(fr|en|ar)\s*:\s*(.+?)\s*(?:=\s*(direct\s+)?(https?:\/\/\S+))?\s*$/i)).filter(Boolean)
    .map((m) => ({ langue: m[1].toLowerCase(), nom: m[2].trim(), flux: m[4] || "", direct: !!m[3] }));
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
  const ph = ` ${plat(c.nom)} `;
  const pays = { fr: ["FR", "US"], en: ["US", "GB"], ar: ["SA", "AE", "US"] }[c.langue] || ["FR", "US"];
  let best = null;
  for (const p of pays) {
    await dormir(1500);
    const j = await get(`https://itunes.apple.com/search?media=podcast&limit=15&country=${p}&term=${encodeURIComponent(c.nom)}`, { json: true });
    for (const r of j?.results || []) {
      if (!r.feedUrl) continue;
      // le nom doit figurer TEL QUEL (mots entiers) dans le titre du podcast, ou être exactement le nom de l'auteur
      const col = ` ${plat(r.collectionName)} `, aut = ` ${plat(r.artistName)} `;
      const tous = (x) => ph.trim().split(" ").every((w) => x.includes(` ${w} `));       // tous les mots, dans le désordre
      const sc = col === ph ? 3 : col.includes(ph) ? 2 : aut === ph ? 1.5 : tous(col) ? 1 : 0;
      if (!sc) continue;
      const t = Date.parse(r.releaseDate || 0) || 0;
      if (!best || sc > best.sc || (sc === best.sc && t > best.t)) best = { sc, t, flux: r.feedUrl, titre: r.collectionName, auteur: r.artistName };
    }
    if (best?.sc === 3) break;
    await dormir(3000);             // annuaire limité à ~20 requêtes/min : on reste en dessous
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

// sons YouTube déposés par l'agent du TÉLÉPHONE (release temporaire « out-ecoute-telephone ») : lus ici, puis supprimés
// définitivement par nettoyer.mjs une fois la War Room écrite. Sans release ou sans réseau : rien, la War Room continue.
const TAG_TEL = "out-ecoute-telephone";
async function telephone() {
  const repo = process.env.GITHUB_REPOSITORY || "MaxMcNeil/Push-overlay";
  const h = { "user-agent": "warroom", accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
  let rel = null;
  try { const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${TAG_TEL}`, { headers: h, signal: AbortSignal.timeout(20000) }); if (r.ok) rel = await r.json(); } catch {}
  if (!rel) { log("  téléphone : aucun son déposé (agent pas installé, ou rien de neuf)"); return { eps: [], perimes: [] }; }
  const A = rel.assets || [], eps = [], perimes = [];
  for (const j of A.filter((a) => /^yt-.+\.json$/.test(a.name))) {
    const m = await get(j.browser_download_url, { json: true });
    const son = m && A.find((a) => a.name === m.fichier);
    if (!m || !son) { perimes.push(j.id); continue; }
    if (Date.now() - Date.parse(m.date) > FENETRE_H * 3600e3) { perimes.push(j.id, son.id); continue; }
    eps.push({ nom: m.nom, media: m.media || m.nom, langue: m.langue || "fr", titre: String(m.titre || "").slice(0, 200), date: m.date, audio: son.browser_download_url,
      lien: m.lien || "", minutes: Number(m.minutes) || MIN_EP, flux: `telephone:${son.id}`, assets: [j.id, son.id] });
  }
  const orphelins = A.filter((a) => /^yt-/.test(a.name) && !/\.json$/.test(a.name) && !A.some((j) => j.name === a.name.replace(/\.[^.]+$/, ".json")));
  perimes.push(...orphelins.map((a) => a.id));
  log(`  téléphone : ${eps.length} vidéo(s) YouTube déposée(s)${perimes.length ? `, ${perimes.length} fichier(s) périmé(s) à supprimer` : ""}`);
  return { eps, perimes };
}

export async function planifier() {
  mkdirSync(OUT, { recursive: true });
  const cat = lireCatalogue();
  const eps = [], sautes = [];
  for (const c of cat) {
    if (c.direct) {       // radio en DIRECT : enregistrée pendant le lancement (ce qui passe à l'antenne à ce moment-là)
      eps.push({ nom: c.nom, media: c.nom, langue: c.langue || "fr", titre: `${c.nom} en direct`, date: new Date().toISOString(), audio: c.flux, lien: "", minutes: MIN_DIRECT, direct: true, flux: c.flux });
      log(`  ✓ ${c.nom} : direct, ${MIN_DIRECT} min enregistrées pendant le lancement`); continue;
    }
    let flux = c.flux, info = "";
    if (!flux) {
      const f = await trouverFlux(c);
      if (!f) { sautes.push(`${c.nom} : introuvable dans l'annuaire des podcasts`); continue; }
      flux = f.flux; info = ` → « ${f.titre} » (${f.auteur})`;
      if (!c.langue) c.langue = "fr";
    }
    if (eps.some((e) => e.flux === flux)) { log(`  = ${c.nom} : même flux qu'un média déjà retenu`); continue; }
    const r = await dernierEpisode(c, flux);
    if (!r.ep) { sautes.push(`${c.nom}${info} [${flux}] : ${r.raison}`); continue; }
    eps.push({ ...r.ep, flux });
    log(`  ✓ ${c.nom}${info} [${flux}] : « ${r.ep.titre.slice(0, 80)} » (${r.ep.date.slice(0, 16).replace("T", " ")}, ${r.ep.minutes || "?"} min)`);
  }
  for (const s of sautes) log(`  – ${s}`);
  const tel = await telephone();
  for (const e of tel.eps) log(`  ✓ ${e.media} : « ${e.titre.slice(0, 80)} » (${e.date.slice(0, 16).replace("T", " ")}, ${e.minutes} min)`);
  eps.push(...tel.eps);
  // répartition : les plus récents d'abord, 45 min max par épisode, 90 min par machine, au plus MACHINES machines
  eps.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const lots = [];
  for (const e of eps) {
    const m = e.direct ? MIN_DIRECT : Math.min(MIN_EP, e.minutes || MIN_EP);
    // l'arabe est transcrit avec un modèle plus précis, environ 3 fois plus lent : il compte triple dans la charge d'une machine
    const charge = m * (["fr", "en"].includes(e.langue || "fr") ? 1 : 3);
    // un direct dure en temps réel (20 min d'enregistrement) : chacun a sa propre machine, jamais à la suite d'un autre
    let lot = e.direct ? null : lots.find((l) => !l.direct && l.minutes + charge <= MIN_MACHINE);
    if (!lot && lots.length < MACHINES) lots.push((lot = { minutes: 0, audio: 0, eps: [], direct: !!e.direct }));
    if (!lot) { log(`  (plafond d'écoute atteint : ${e.nom} non écouté)`); continue; }
    lot.minutes += charge; lot.audio += m; lot.eps.push({ ...e, ecoute: m });
  }
  // à supprimer après la War Room : les sons du téléphone écoutés + les périmés (jamais un son pas encore écouté)
  const ecoutes = lots.flatMap((l) => l.eps.filter((e) => e.assets).map((e) => e.assets));
  const plan = { date: new Date().toISOString(), episodes: eps.length, lots: lots.map((l) => l.eps), telephone: { tag: TAG_TEL, perimes: tel.perimes, ecoutes } };
  writeFileSync(`${OUT}/plan.json`, JSON.stringify(plan, null, 1));
  log(`\nÉcoute : ${cat.length} médias au catalogue, ${eps.length} épisode(s) des ${FENETRE_H} dernières heures, ${lots.length} machine(s), ${lots.reduce((s, l) => s + l.audio, 0)} min d'audio.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrice=${JSON.stringify(lots.map((_, i) => i))}\n`);
  return plan;
}

if (process.argv[1] && process.argv[1].endsWith("plan.mjs")) await planifier();
