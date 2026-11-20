// scripts/warroom/ecrire.mjs — WAR ROOM DU JOUR, étapes 2 à 4 :
//   2) regrouper les articles qui parlent du même événement, faire noter par l'IA le CHOC de chaque sujet (0 à 10),
//      garder seulement ce qui est solide (≥ 2 sources indépendantes, ou une source officielle, ou une revendication
//      présentée comme telle) ;
//   3) lire les articles des sujets retenus (texte réel), écrire chaque DOSSIER dans le style de la chaîne + les données
//      de l'écran War Room (titre, faits clés, chiffre clé, lieu, gravité, sources) ; tout chiffre absent des sources est retiré ;
//   4) ordre « démarrer fort, finir encore plus fort », ouverture, transitions, clôture → prompteur + plan de l'écran.
// Sorties (output/warroom) : prompteur.txt, warroom.json (pour l'écran), sources.md, journal des choix.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { providers, parseJson } from "../lib/llm.mjs";
import { collecter } from "./collect.mjs";

const OUT = "output/warroom";
const WPM = Number(process.env.WARROOM_WPM || 145);
const MAX_DOSSIERS = Number(process.env.WARROOM_MAX || 25);
const T0 = Date.now(), BUDGET = Number(process.env.WARROOM_BUDGET_MIN || 120) * 60e3;
const reste = () => BUDGET - (Date.now() - T0);
const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- IA patiente (surcharge = attendre, jamais abandonner tôt)
async function ia(sys, user, { tours = 4, maxTokens = 6000 } = {}) {
  const prov = providers();
  if (!prov.length) throw new Error("aucune clé IA (GEMINI_API_KEY / GROQ_API_KEY)");
  let last = null;
  for (let k = 0; k < tours; k++) {
    if (k) { const w = [0, 45, 90, 180][k] || 180; if (reste() < (w + 120) * 1e3) break; log(`  IA indisponible : nouvel essai dans ${w} s`); await dormir(w); }
    for (const [nom, fn] of prov) {
      if (reste() < 90e3) break;
      try {
        const j = parseJson(await fn(sys, user, { json: true, temperature: 0.6, maxTokens, deadline: Date.now() + Math.min(7 * 60e3, reste() - 60e3) }));
        if (j) return j;
        last = new Error(`${nom} : réponse illisible`);
      } catch (e) { last = e; log(`  ${nom} : ${String(e.message).slice(0, 140)}`); }
    }
  }
  throw last || new Error("IA indisponible");
}

// ---------------------------------------------------------------- 2) regrouper par événement
const MOTS_VIDES = new Set("le la les un une des de du d l et ou en au aux a à pour par sur dans avec sans the of to in on for and or with at by from is are was were be after over says say new news".split(" "));
const mots = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9؀-ۿ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !MOTS_VIDES.has(w));
function regrouper(items) {
  const G = [];
  for (const x of items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))) {
    const m = new Set(mots(x.titre));
    let best = null, bs = 0;
    for (const g of G) {
      let inter = 0; for (const w of m) if (g.mots.has(w)) inter++;
      const sc = inter / Math.max(3, Math.min(m.size, g.mots.size));
      if (sc > bs) { bs = sc; best = g; }
    }
    if (best && bs >= 0.5) { best.items.push(x); for (const w of m) best.mots.add(w); }
    else G.push({ items: [x], mots: m });
  }
  return G.map((g, i) => {
    const sources = new Set(g.items.map((x) => (x.source || "").toLowerCase().replace(/^www\./, "")).filter(Boolean));
    return { id: i + 1, items: g.items, nb_sources: sources.size, officiel: g.items.some((x) => x.officiel), revendication: g.items.every((x) => x.revendication) };
  });
}

// ---------------------------------------------------------------- 2bis) l'IA note le choc (par paquets)
async function trier(groupes) {
  const notes = new Map();
  for (let k = 0; k < groupes.length; k += 60) {
    const lot = groupes.slice(k, k + 60);
    const liste = lot.map((g) => `#${g.id} [${g.nb_sources} source(s)${g.officiel ? ", officiel" : ""}${g.revendication ? ", REVENDICATION non confirmée" : ""}] ${g.items.slice(0, 3).map((x) => x.titre).join(" | ").slice(0, 300)}`).join("\n");
    try {
      const j = await ia("Tu es rédacteur en chef d'une émission d'actualité choc. Réponds en JSON valide.",
        `Pour chaque sujet ci-dessous (actualité des dernières 24 h), donne :
- "choc" : 0 à 10 = à quel point il CHOQUE, INDIGNE ou INQUIÈTE le grand public (catastrophe, morts, scandale, corruption, accident grave,
  guerre, escalade, fuite, révélation, piratage, fait divers grave, insolite et grave, rumeur/complot qui fait le buzz). 0 = banal, sport,
  people sans gravité, promotion, publicité, météo ordinaire, bourse ordinaire.
- "categorie" : CATASTROPHE, ACCIDENT, SCANDALE, CORRUPTION, POLITIQUE, GÉOPOLITIQUE, GUERRE, RÉVÉLATION, CYBER, FAIT DIVERS, INSOLITE ou RUMEUR.
- "doublon_de" : numéro d'un AUTRE sujet de la liste qui parle du même événement, sinon 0.
- "pays" : pays principal concerné (en français), "ville" si connue.
Réponds : {"sujets": [{"id": 12, "choc": 8, "categorie": "SCANDALE", "doublon_de": 0, "pays": "France", "ville": ""}, …]}

${liste}`, { maxTokens: 6000 });
      for (const s of j.sujets || []) if (s && isFinite(s.id)) notes.set(Number(s.id), s);
    } catch (e) { log(`  tri d'un paquet impossible (${e.message}) : ces sujets sont écartés`); }
  }
  // doublons signalés par l'IA : fusionnés dans le sujet le plus fourni
  for (const g of groupes) {
    const n = notes.get(g.id), d = n && Number(n.doublon_de);
    const cible = d && groupes.find((x) => x.id === d && x !== g && !x.fusionne);
    if (cible) { cible.items.push(...g.items); cible.nb_sources = new Set(cible.items.map((x) => (x.source || "").toLowerCase())).size; cible.officiel ||= g.officiel; g.fusionne = true; }
  }
  return groupes.filter((g) => !g.fusionne).map((g) => ({ ...g, note: notes.get(g.id) })).filter((g) => g.note);
}

// ---------------------------------------------------------------- 3) lire les vrais articles
function texteArticle(html) {
  const ps = [...String(html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&[lr]dquo;/g, '"').replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 60 && !/cookie|abonn|subscribe|newsletter|javascript|tous droits|all rights reserved/i.test(p));
  return ps.join("\n").slice(0, 5000);
}
async function lire(url) {
  if (!url || /news\.google\.com/.test(url)) return "";
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    if (!r.ok) return "";
    return texteArticle(await r.text());
  } catch { return ""; }
}
async function enrichir(g) {
  const urls = [...new Set(g.items.map((x) => x.url).filter((u) => u && !/news\.google\.com/.test(u)))].slice(0, 3);
  if (urls.length < 2) {                // presse trouvée par Google News : liens directs cherchés via GDELT (mêmes mots-clés)
    const q = mots(g.items[0].titre).slice(0, 6).join(" ");
    try {
      const r = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=8&timespan=48h&format=json`, { signal: AbortSignal.timeout(30000) });
      const j = r.ok ? await r.json() : null;
      for (const a of j?.articles || []) if (urls.length < 3 && a.url && !urls.includes(a.url)) { urls.push(a.url); g.items.push({ titre: a.title, url: a.url, source: a.domain, date: new Date().toISOString(), origine: "gdelt" }); }
    } catch {}
    await dormir(5.5);
  }
  const textes = (await Promise.all(urls.map(lire))).filter(Boolean);
  g.texte = [g.items.map((x) => `• ${x.titre}${x.resume ? ` — ${x.resume}` : ""} (${x.source})`).join("\n"), ...textes].join("\n\n").slice(0, 9000);
  g.nb_sources = new Set(g.items.map((x) => (x.source || "").toLowerCase().replace(/^www\./, ""))).size;
  return g;
}

// ---------------------------------------------------------------- 3bis) écrire un dossier
const NOUS = /\b(nous|notre|nos)\b/i;
const QUEMANDE = /\b(likez|liker|partagez|abonnez|abonnez-vous|mettez un pouce|lâchez un like)\b|[ée]crivez\s+\S+\s+(dans le chat\s+)?si\b|tapez\s+\S+\s+si\b/i;
const chiffres = (s) => (String(s).match(/\d[\d\s.,]*\d|\d/g) || []).map((n) => n.replace(/[\s.,]/g, "")).filter((n) => n.length >= 2);
function chiffresSurs(texte, source) {
  const ok = new Set(chiffres(source));
  return chiffres(texte).every((n) => ok.has(n) || /^(19|20)\d\d$/.test(n) || n.length < 2);
}
async function ecrireDossier(g) {
  const n = g.note, rev = g.revendication, rumeur = n.categorie === "RUMEUR";
  const mots_cible = Math.round(Math.max(170, Math.min(520, 120 + g.texte.length / 25)));
  const j = await ia("Tu écris pour un live YouTube d'actualité choc (chaîne « Le Journal du NON »). Réponds en JSON valide.",
    `Écris le DOSSIER ci-dessous pour le présentateur, qui le lira au prompteur.
STYLE : expert géopolitique et analyste, choc, alarmiste mais factuel, humour noir en contrepoint ; oral, phrases courtes ; mini-hook
d'ouverture, les faits, le décryptage (qui gagne, qui perd, ce qu'on ne vous dit pas), une punchline, puis UNE question ouverte au public.
HORS DU CONTEXTE : jamais « nous », « notre », « nos » ; dis « la France », « les Français », « vous », « je ».
JAMAIS « likez », « partagez », « abonnez-vous », ni « écrivez X si… / tapez X si… ».
EXACTITUDE (protection juridique) : n'utilise QUE les faits des sources ci-dessous ; aucun chiffre, nom, date ou citation inventé. Une
accusation reste une accusation (« selon… », « soupçonné », « présumé »).${rev ? ` C'est une REVENDICATION de cybercriminels sur leur site de
fuite, NON CONFIRMÉE : dis-le clairement (« revendique », « affirme », « rien ne confirme pour l'instant »).` : ""}${rumeur ? ` C'est une RUMEUR /
théorie qui circule : raconte ce qui circule et pourquoi ça prend, puis ce qu'on sait vraiment d'après les vérifications.` : ""}
LONGUEUR : environ ${mots_cible} mots.
ÉCRAN (affiché derrière le présentateur) : titre en 3 à 7 mots ; 3 faits clés de 4 à 10 mots chacun, dans l'ordre où tu en parles ;
un chiffre clé SEULEMENT s'il est dans les sources ; gravité 1 à 5.
Réponds : {"titre_ecran": "…", "texte": "…", "faits_cles": ["…","…","…"], "chiffre_cle": {"valeur": "…", "libelle": "…"} ou null,
"gravite": 4, "lieu": "Ville, Pays", "accroche_teaser": "une phrase de 12 mots max pour annoncer ce dossier plus tôt dans le live"}

CATÉGORIE : ${n.categorie} — PAYS : ${n.pays || "?"}
SOURCES (${g.nb_sources}) :
${g.texte}`, { maxTokens: 3500 });
  let texte = String(j.texte || "").replace(/\s+\n/g, "\n").trim();
  // contrôle : phrases avec « nous », quémande de likes, ou chiffre absent des sources → retirées
  const phr = texte.split(/(?<=[.!?…])\s+/);
  const bonnes = phr.filter((p) => !NOUS.test(p) && !QUEMANDE.test(p) && chiffresSurs(p, g.texte));
  if (bonnes.length < phr.length) log(`    ${phr.length - bonnes.length} phrase(s) retirée(s) (chiffre absent des sources, « nous » ou appel au like)`);
  texte = bonnes.join(" ");
  const cle = j.chiffre_cle && j.chiffre_cle.valeur && chiffresSurs(j.chiffre_cle.valeur, g.texte) ? { valeur: String(j.chiffre_cle.valeur).slice(0, 18), libelle: String(j.chiffre_cle.libelle || "").slice(0, 60) } : null;
  const faits = (Array.isArray(j.faits_cles) ? j.faits_cles : []).map((x) => String(x).slice(0, 80)).filter((x) => x && chiffresSurs(x, g.texte)).slice(0, 3);
  if (texte.split(/\s+/).length < 60) throw new Error("dossier trop court après contrôle");
  return {
    categorie: n.categorie, choc: Number(n.choc) || 0, gravite: Math.max(1, Math.min(5, Number(j.gravite) || Math.round((Number(n.choc) || 5) / 2))),
    titre: String(j.titre_ecran || g.items[0].titre).slice(0, 70), lieu: String(j.lieu || [n.ville, n.pays].filter(Boolean).join(", ")).slice(0, 60),
    pays: n.pays || "", faits, chiffre: cle, texte, teaser: String(j.accroche_teaser || "").slice(0, 120), revendication: !!rev, rumeur,
    sources: [...new Map(g.items.filter((x) => x.source).map((x) => [x.source, { nom: x.source, url: x.url || "" }])).values()].slice(0, 6),
  };
}

// ---------------------------------------------------------------- 4) ordre, ouverture, transitions, clôture
async function habiller(dossiers) {
  // « démarrer fort, finir encore plus fort » : le 2e plus explosif en premier, montée en intensité, la bombe à la fin
  const tri = [...dossiers].sort((a, b) => b.choc - a.choc || b.gravite - a.gravite);
  const ordre = tri.length > 2 ? [tri[1], ...tri.slice(2).reverse(), tri[0]] : tri.reverse();
  let hab = { ouverture: "", transitions: [], cloture: "" };
  try {
    hab = await ia("Tu écris pour un live YouTube d'actualité choc (« Le Journal du NON »). Réponds en JSON valide.",
      `Voici les dossiers du live, dans l'ordre. Écris :
- "ouverture" (90 à 150 mots) : hook ultra-choc construit sur le dossier 1, teaser de la bombe finale (dernier dossier) sans la dévoiler,
  puis la phrase d'accueil exacte « Bienvenue dans le Journal du NON, et la réponse est Non. », puis une question ouverte au public ;
- "transitions" : pour chaque dossier à partir du 2e, UNE phrase (10 à 25 mots) qui fait le lien avec le précédent et accroche ;
- "cloture" (60 à 110 mots) : la bombe est passée, synthèse percutante, question ouverte au public, rendez-vous au prochain live SANS date.
Règles : jamais « nous / notre / nos », jamais « likez / partagez / abonnez-vous », jamais « écrivez X si… ». Rien d'inventé.
Réponds : {"ouverture": "…", "transitions": ["…", …], "cloture": "…"}

${ordre.map((d, i) => `${i + 1}. [${d.categorie}] ${d.titre} — ${d.teaser || d.faits[0] || ""}`).join("\n")}`, { maxTokens: 3000 });
  } catch (e) { log(`  ouverture/transitions impossibles (${e.message}) : repli sobre`); }
  const propre = (s) => String(s || "").split(/(?<=[.!?…])\s+/).filter((p) => !NOUS.test(p) && !QUEMANDE.test(p)).join(" ").trim();
  return {
    ordre,
    ouverture: propre(hab.ouverture) || "Bienvenue dans le Journal du NON, et la réponse est Non. L'actualité du jour ne va pas vous rassurer.",
    transitions: ordre.map((_, i) => (i ? propre((hab.transitions || [])[i - 1]) : "")),
    cloture: propre(hab.cloture) || "Voilà pour ce tour de la War Room. Et vous, quel dossier vous inquiète le plus ce soir ?",
  };
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const duree = (t) => (String(t).split(/\s+/).filter(Boolean).length / WPM) * 60;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { items, etat } = existsSync(process.env.WARROOM_BRUT || "") ? { items: JSON.parse(readFileSync(process.env.WARROOM_BRUT, "utf8")), etat: {} } : await collecter();
  const groupes = regrouper(items);
  log(`${groupes.length} événements distincts`);
  const notes = await trier(groupes);
  const solides = notes.filter((g) => g.nb_sources >= 2 || g.officiel || g.revendication);
  const retenus = solides.filter((g) => Number(g.note.choc) >= Number(process.env.WARROOM_SEUIL || 6))
    .sort((a, b) => (Number(b.note.choc) + (b.officiel ? 0.5 : 0) + Math.min(1.5, b.nb_sources * 0.25)) - (Number(a.note.choc) + (a.officiel ? 0.5 : 0) + Math.min(1.5, a.nb_sources * 0.25)))
    .slice(0, MAX_DOSSIERS + 6);                   // quelques réserves si un dossier ne tient pas après contrôle
  log(`${solides.length} sujets solides (≥ 2 sources ou source officielle), ${retenus.length} assez choc retenus`);
  const dossiers = [];
  for (const g of retenus) {
    if (dossiers.length >= MAX_DOSSIERS || reste() < 8 * 60e3) break;
    await enrichir(g);
    try { const d = await ecrireDossier(g); dossiers.push(d); log(`  ✓ [${d.categorie}] ${d.titre} (${d.texte.split(/\s+/).length} mots, ${g.nb_sources} sources)`); }
    catch (e) { log(`  ✗ ${g.items[0].titre.slice(0, 80)} : ${e.message}`); }
  }
  if (!dossiers.length) throw new Error("aucun dossier assez solide aujourd'hui (sources ou IA indisponibles) : relance plus tard");
  const { ordre, ouverture, transitions, cloture } = await habiller(dossiers);
  // minutage (débit de lecture) + prompteur avec repères
  let t = 0;
  const P = [`WAR ROOM — ${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`, "", "▶ OUVERTURE", "", ouverture, ""];
  const segs = [{ type: "ouverture", t0: 0, t1: (t += duree(ouverture)) }];
  ordre.forEach((d, i) => {
    const tx = [transitions[i], d.texte].filter(Boolean).join(" ");
    const t0 = t; t += duree(tx);
    segs.push({ type: "dossier", n: i + 1, t0, t1: t, ...d, texte: undefined });
    P.push(`▶ DOSSIER ${i + 1}/${ordre.length} · ${d.categorie} · ${mmss(t0)}`, `« ${d.titre} »`, "", tx, "");
  });
  segs.push({ type: "cloture", t0: t, t1: (t += duree(cloture)) });
  P.push(`▶ CLÔTURE · ${mmss(segs[segs.length - 1].t0)}`, "", cloture, "");
  const spec = { version: 1, date: new Date().toISOString(), wpm: WPM, duree: t, segments: segs, ticker: ordre.map((d) => d.titre) };
  writeFileSync(`${OUT}/prompteur.txt`, P.join("\n"));
  writeFileSync(`${OUT}/warroom.json`, JSON.stringify(spec, null, 1));
  writeFileSync(`${OUT}/sources.md`, ["# Sources — War Room du jour", "", ...ordre.flatMap((d, i) => [`## ${i + 1}. ${d.titre}`, ...d.sources.map((s) => `- ${s.nom}${s.url ? ` — ${s.url}` : ""}`), ""])].join("\n"));
  log(`\nWar Room prête : ${ordre.length} dossiers, ≈ ${Math.round(t / 60)} min de lecture (${WPM} mots/min). Sources : ${JSON.stringify(etat)}`);
}

if (process.argv[1] && process.argv[1].endsWith("ecrire.mjs")) await main().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
