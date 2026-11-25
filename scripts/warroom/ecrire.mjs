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
import { collecter, deshtml, GOLFE } from "./collect.mjs";

const OUT = "output/warroom";
// ÉDITION : France (Le Journal du NON, défaut) ou Golfe (Gulf Think-Tank : écrit et vérifié en français, puis traduit en arabe standard)
const ED = GOLFE ? {
  chaine: "Gulf Think-Tank",
  public: "pour le public des pays du GOLFE (Arabie saoudite, Émirats arabes unis, Qatar, Koweït, Oman, Bahreïn)",
  interet: `- "interet_fr" : 0 à 10 = à quel point le public du GOLFE s'y intéresse. Tout ce qui se passe dans les 6 pays du Golfe ou les
  touche directement (sécurité du Golfe, Iran, Yémen, mer Rouge, pétrole, investissements, diplomatie régionale, grandes puissances au
  Moyen-Orient, monde arabe, menace mondiale) = 7 à 10. Un événement lointain sans lien avec le Golfe = 0 à 3, sauf ampleur exceptionnelle.
- "tabou_golfe" : true si le sujet consiste à attaquer LA PERSONNE d'un souverain du Golfe (roi, émir, sultan, prince héritier) ou de
  sa famille, ou l'islam ; sinon false (critiquer les décisions d'un gouvernement du Golfe est permis).`,
  contexte: `PUBLIC DU GOLFE : jamais « nous », « notre », « nos » ; dis « vous », « je ».
RÈGLE ABSOLUE : AUCUNE attaque, moquerie ou insinuation visant LA PERSONNE des souverains du Golfe (rois, émirs, sultans, princes
héritiers) ou de leurs familles, ni l'islam, les lieux saints et les symboles religieux.
PERMIS (et attendu, sinon le public te prendra pour un flatteur d'un État) : critiquer les DÉCISIONS, politiques et opérations des
gouvernements, ministères, armées et institutions du Golfe, avec des faits et toujours attribuées (« selon X », « d'après la source Y »,
« une seule source, invérifiable à ce stade, affirme que… ») ; on vise la décision, jamais la personne du souverain. La virulence, l'ironie mordante et l'humour noir visent les puissances étrangères, l'hypocrisie occidentale, le deux poids deux
mesures, la propagande, les milices et groupes armés, les médias qui manipulent — jamais les victimes.
LES MAUVAISES NOUVELLES qui touchent un pays du Golfe (attaques, menaces, pertes économiques, incidents, rumeurs) sont les bienvenues
et donnent du piquant : raconte-les comme des faits, avec leur gravité, au conditionnel et en disant clairement « non confirmé » ou
« une seule source, invérifiable à ce stade, affirme que… » quand c'est le cas.`,
  signature: "La position du jour",
  accueil: "Bienvenue dans la War Room de Gulf Think-Tank.",
  paysPublic: /arabie|saoudi|[ée]mirats|qatar|kowe[iï]t|oman|bahre[iï]n|golfe/i,
  France: "le Golfe",
} : {
  chaine: "Le Journal du NON",
  public: "pour un public FRANÇAIS",
  interet: null,
  contexte: null,
  signature: "Le NON du jour",
  accueil: "Bienvenue dans le Journal du NON, et la réponse est Non.",
  paysPublic: /^france$/i,
  France: "la France",
};
const SIGN = new RegExp(`^${ED.signature}`, "i");
const WPM = Number(process.env.WARROOM_WPM || (GOLFE ? 105 : 145));          // l'arabe se lit plus lentement
const MAX_DOSSIERS = Number(process.env.WARROOM_MAX || 15);
const T0 = Date.now(), BUDGET = Number(process.env.WARROOM_BUDGET_MIN || 120) * 60e3;
const reste = () => BUDGET - (Date.now() - T0);
const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- IA patiente (surcharge = attendre, jamais abandonner tôt)
async function ia(sys, user, { tours = 4, maxTokens = 6000, depart = 0, temperature = 0.6 } = {}) {
  const p0 = providers();
  const prov = p0.map((_, i) => p0[(i + depart) % p0.length]);      // « voies » parallèles : chacune commence par un fournisseur différent
  if (!prov.length) throw new Error("aucune clé IA (GEMINI_API_KEY / GROQ_API_KEY)");
  let last = null;
  for (let k = 0; k < tours; k++) {
    if (k) { const w = [0, 45, 90, 180][k] || 180; if (reste() < (w + 120) * 1e3) break; log(`  IA indisponible : nouvel essai dans ${w} s`); await dormir(w * (1 + Math.random() * 0.25)); }
    for (const [nom, fn] of prov) {
      if (reste() < 90e3) break;
      try {
        const j = parseJson(await fn(sys, user, { json: true, temperature, maxTokens, deadline: Date.now() + Math.min(7 * 60e3, reste() - 60e3) }));
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
  const file = [];
  for (let k = 0; k < groupes.length; k += 60) file.push(groupes.slice(k, k + 60));
  while (file.length) {
    const lot = file.shift();
    const liste = lot.map((g) => `#${g.id} [${g.nb_sources} source(s)${g.officiel ? ", officiel" : ""}${g.revendication ? ", REVENDICATION non confirmée" : ""}] ${g.items.slice(0, 3).map((x) => x.titre).join(" | ").slice(0, 300)}`).join("\n");
    try {
      const j = await ia(`Tu es rédacteur en chef d'une émission d'actualité choc ${ED.public}. Réponds en JSON valide.`,
        `Pour chaque sujet ci-dessous (actualité des dernières 24 h), donne :
- "choc" : 0 à 10 = à quel point il CHOQUE, INDIGNE ou INQUIÈTE le grand public (catastrophe, morts, scandale, corruption, accident grave,
  guerre, escalade, fuite, révélation, piratage, fait divers grave, insolite et grave, rumeur/complot qui fait le buzz). 0 = banal, sport,
  people sans gravité, promotion, publicité, météo ordinaire, bourse ordinaire.
- "categorie" : CATASTROPHE, ACCIDENT, SCANDALE, CORRUPTION, POLITIQUE, GÉOPOLITIQUE, GUERRE, RÉVÉLATION, CYBER, FAIT DIVERS, INSOLITE ou RUMEUR.
  Échelle MONDIALE : un accident ou un fait divers local avec une seule victime vaut 4 au plus (sauf circonstances inouïes) ;
  une guerre qui s'étend, une catastrophe meurtrière, un scandale d'État, une fuite massive valent 8 à 10.
${ED.interet || `- "interet_fr" : 0 à 10 = à quel point un Français moyen s'y intéresse et en parlerait. Tout ce qui se passe EN FRANCE ou touche
  directement les Français (victimes françaises, argent, prix, énergie, sécurité, Europe, guerre aux portes de l'Europe, grandes
  puissances, menace mondiale, buzz mondial) = 7 à 10. Un événement lointain sans lien avec la France (petit pays, politique locale
  étrangère, fait divers à l'étranger) = 0 à 3, même s'il est grave, SAUF s'il est d'une ampleur exceptionnelle.`}
- "actuel" : true si c'est un FAIT NOUVEAU des dernières 48 h ; false si c'est un récit du passé, un portrait, une rétrospective,
  un anniversaire, un documentaire, une série, un livre, une analyse sans fait nouveau.
- "categorie" : CATASTROPHE, ACCIDENT, SCANDALE, CORRUPTION, POLITIQUE, GÉOPOLITIQUE, GUERRE, RÉVÉLATION, CYBER, FAIT DIVERS, INSOLITE ou RUMEUR.
- "evenement" : l'événement en 3 à 8 mots, nommé de façon CANONIQUE (ex. « missile houthi sur gratte-ciel de Riyad »), pour repérer
  les doublons : deux sujets sur le même événement doivent recevoir la même formulation.
- "doublon_de" : numéro d'un AUTRE sujet de la liste qui parle du même événement, sinon 0.
- "pays" : pays principal concerné (en français), "ville" si connue.
Réponds : {"sujets": [{"id": 12, "choc": 8, "interet_fr": 9, "actuel": true, "categorie": "SCANDALE", "evenement": "…", "doublon_de": 0, "pays": "France", "ville": ""}, …]}

${liste}`, { maxTokens: 6000 });
      for (const s of j.sujets || []) if (s && isFinite(s.id)) notes.set(Number(s.id), s);
    } catch (e) {
      // paquet trop long ou IA saturée : coupé en deux et retenté (plus petit = accepté par plus de modèles, moins de quota par appel)
      if (lot.length > 8 && reste() > 10 * 60e3) { log(`  tri de ${lot.length} sujets impossible (${String(e.message).slice(0, 80)}) : coupé en deux`); file.unshift(lot.slice(0, lot.length >> 1), lot.slice(lot.length >> 1)); }
      else log(`  tri de ${lot.length} sujets impossible (${e.message}) : ces sujets sont écartés`);
    }
  }
  // doublons signalés par l'IA : fusionnés dans le sujet le plus fourni
  for (const g of groupes) {
    const n = notes.get(g.id), d = n && Number(n.doublon_de);
    const cible = d && groupes.find((x) => x.id === d && x !== g && !x.fusionne);
    if (cible) { cible.items.push(...g.items); cible.nb_sources = new Set(cible.items.map((x) => (x.source || "").toLowerCase())).size; cible.officiel ||= g.officiel; g.fusionne = true; }
  }
  return groupes.filter((g) => !g.fusionne).map((g) => ({ ...g, note: notes.get(g.id) })).filter((g) => g.note);
}

// ---------------------------------------------------------------- 2ter) un seul dossier par événement (sur toute la liste)
// Les paquets de tri ne se voient pas entre eux : la même frappe peut sortir 3 fois. L'IA regroupe la liste finale ; un même
// événement ou sa suite directe du jour (ex. frappes sur Kyiv + projectile tombé en Pologne) = UN dossier, toutes sources réunies.
function fusionnerDans(cible, g) {
  cible.items.push(...g.items);
  cible.nb_sources = new Set(cible.items.map((x) => (x.source || "").toLowerCase().replace(/^www\./, ""))).size;
  cible.officiel ||= g.officiel; cible.revendication &&= g.revendication;
  if (Number(g.note.choc) > Number(cible.note.choc)) cible.note = { ...cible.note, choc: g.note.choc };
  g.fusionne = true;
}
async function fusionner(cands) {
  const liste = cands.map((g, i) => `#${i} [${g.note.pays || "?"}] ${g.note.evenement || ""} :: ${g.items.slice(0, 3).map((x) => x.titre).join(" | ").slice(0, 260)}`).join("\n");
  let groupes = null;
  try {
    const j = await ia("Tu es rédacteur en chef. Réponds en JSON valide.",
      `Voici les sujets retenus pour le live. Le public ne doit JAMAIS entendre deux fois la même histoire : regroupe tous ceux qui
relèvent du MÊME SUJET du jour — même loi ou même vote (à toutes ses étapes), même affaire ou procès, même fuite de données, même
catastrophe, et pour une guerre ou une crise : même pays visé / même front (ex. tous les sujets « frappes contre l'Iran »,
« menaces de l'Iran », « report des frappes » = UN groupe ; tous les sujets « missiles / objet tombé en Pologne » = UN groupe).
Restent séparés : des sujets vraiment distincts (ex. une attaque houthie sur Riyad et le dossier Iran-États-Unis).
Réponds : {"groupes": [[0, 7], [3, 12, 15]]} (seulement les groupes de 2 sujets ou plus ; [] s'il n'y a aucun doublon).

${liste}`, { maxTokens: 1500 });
    groupes = Array.isArray(j.groupes) ? j.groupes : null;
  } catch (e) { log(`  regroupement par l'IA impossible (${e.message}) : regroupement par mots-clés`); }
  if (!groupes) {        // repli : même pays et événement formulé presque pareil
    groupes = [];
    const vus = new Set();
    cands.forEach((a, i) => {
      if (vus.has(i)) return;
      const ma = new Set(mots(a.note.evenement || a.items[0].titre)), g = [i];
      cands.forEach((b, k) => {
        if (k <= i || vus.has(k) || (a.note.pays || "") !== (b.note.pays || "")) return;
        const mb = new Set(mots(b.note.evenement || b.items[0].titre));
        let inter = 0; for (const w of ma) if (mb.has(w)) inter++;
        if (inter / Math.max(2, Math.min(ma.size, mb.size)) >= 0.5) { g.push(k); vus.add(k); }
      });
      if (g.length > 1) groupes.push(g);
    });
  }
  let n = 0;
  for (const grp of groupes) {
    const gs = [...new Set((grp || []).map(Number))].filter((i) => cands[i] && !cands[i].fusionne).map((i) => cands[i]);
    if (gs.length < 2) continue;
    gs.sort((a, b) => b.nb_sources - a.nb_sources || Number(b.note.choc) - Number(a.note.choc));
    for (const g of gs.slice(1)) { fusionnerDans(gs[0], g); n++; }
  }
  log(`  ${n} doublon(s) fusionné(s) : ${cands.length - n} événements distincts`);
  return cands.filter((g) => !g.fusionne);
}

// ---------------------------------------------------------------- 3) lire les vrais articles
function texteArticle(html) {
  const ps = [...String(html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1].replace(/<[^>]+>/g, " ")).map((t) => deshtml(deshtml(t)).replace(/\s+/g, " ").trim())
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
  try { const ctx = await contexteWiki(g); if (ctx) g.texte += `\n\nCONTEXTE (Wikipédia, article « ${ctx.titre} ») :\n${ctx.extrait}`; } catch {}
  if (CONTRE_CATS.includes(g.note?.categorie)) {
    const autres = autresPour(g, POOL_AUTRES);
    if (autres.length) g.texte += `\n\nAUTRES LECTURES (presse étrangère et indépendante — à citer avec leur nom) :\n` + autres.map((x) => `• ${x.source} : ${x.titre}${x.resume ? ` — ${x.resume}` : ""}`).join("\n");
    const jugee = /condamn|verdict|jugement|prison ferme|cour d.assises|tribunal|relax|acquitt/.test(plat(g.items.map((x) => `${x.titre} ${x.resume || ""}`).join(" ")));
    g.precedents = jugee ? [] : precedentsPour(g);       // affaire déjà jugée / fait divers : jamais de parallèle historique plaqué
    if (!jugee && !g.precedents.length && ["GÉOPOLITIQUE", "GUERRE", "CYBER", "POLITIQUE", "CORRUPTION", "RÉVÉLATION"].includes(g.note?.categorie)) { try { g.precedents.push(...await precedentsDyn(g, 2 - g.precedents.length)); } catch (e) { log(`    précédents hors catalogue impossibles (${String(e.message).slice(0, 80)})`); } }
    if (g.precedents.length) g.texte += `\n\nPRÉCÉDENTS HISTORIQUES AVÉRÉS RETENUS POUR CE DOSSIER :\n` + g.precedents.map((f) => `• ${f.fait} (Ce précédent illustre : ${f.type}.)`).join("\n");
    g.autres = autres.map((x) => ({ nom: x.source, url: x.url || "" }));
  }
  return g;
}

// ---------------------------------------------------------------- 3a) CONTRE-LECTURE
// Catégories où la contre-lecture est obligatoire ; précédents historiques AVÉRÉS (documentés, reconnus) que le texte peut citer :
// ils sont ajoutés aux sources du dossier, donc la vérification des faits les accepte.
let POOL_AUTRES = [];
const CONTRE_CATS = ["GÉOPOLITIQUE", "GUERRE", "POLITIQUE", "SCANDALE", "CORRUPTION", "CYBER", "RÉVÉLATION"];
// Catalogue des précédents (scripts/warroom/precedents.md, modifiable sans toucher au code). Le PROGRAMME choisit les fiches qui
// collent au dossier ; l'IA ne reçoit que celles-là (0, 1 ou 2), donc elle ne peut ni oublier la bonne ni plaquer une fiche hors sujet.
let _cat = null;
const catalogue = () => _cat || (_cat = (() => {
  try {
    const src = readFileSync(new URL("./precedents.md", import.meta.url), "utf8");
    return src.split(/^## /m).slice(1).map((bloc) => {
      const [nom, ...l] = bloc.split("\n");
      const champ = (k) => (l.find((x) => x.startsWith(k + ":")) || "").slice(k.length + 1).trim();
      const liste = (k) => champ(k).split(",").map((x) => plat(x)).filter(Boolean);
      return { nom: nom.trim(), repere: liste("repere"), mots: liste("mots"), forts: liste("forts"), type: champ("type"), fait: champ("fait") };
    }).filter((f) => f.fait && f.repere.length && f.mots.length);
  } catch (e) { console.log(`::warning::catalogue des précédents illisible (${e.message}) : contre-lecture sans précédent`); return []; }
})());
// ---------------------------------------------------------------- précédents HORS catalogue (tout sujet, présent ou futur)
// L'IA PROPOSE un précédent réel (titre d'article Wikipédia) ; le PROGRAMME vérifie que la page existe et en lit l'extrait officiel ;
// une AUTRE IA écrit le fait UNIQUEMENT à partir de cet extrait et juge le parallèle ; le programme revérifie que dates, chiffres et noms
// du fait figurent bien dans l'extrait. Rien d'inventé ni de plaqué à contresens ne passe : au moindre doute, aucun précédent.
async function wiki(titre) {
  for (const l of ["fr", "en"]) {
    try {
      const r = await fetch(`https://${l}.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&exintro=1&explaintext=1&exchars=1800&redirects=1&ppprop=disambiguation&format=json&titles=${encodeURIComponent(titre)}`,
        { headers: { "user-agent": "JournalDuNon-WarRoom/1.0 (veille d'actualite)" }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const p = Object.values((await r.json()).query?.pages || {})[0];
      const ext = String(p?.extract || "").trim();
      if (!p || p.missing !== undefined || p.pageprops?.disambiguation !== undefined || ext.length < 200) continue;
      return { titre: p.title, extrait: ext, langue: l, url: `https://${l}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}` };
    } catch {}
  }
  return null;
}
// CONTEXTE : l'article Wikipédia de l'affaire, de la personne ou du lieu au cœur du dossier (recherche SANS IA, sur les noms propres
// des titres) ; gardé seulement si son titre partage un nom propre avec le dossier. Il donne le « avant » que les dépêches n'ont pas.
async function contexteWiki(g) {
  const titres = g.items.slice(0, 6).map((x) => x.titre).join(" ");
  const noms = [...new Set((titres.match(/(?<!\p{L})\p{Lu}[\p{L}'’-]{2,}/gu) || []).filter((w) => !MAJ_COURANTS.has(plat(w))))].slice(0, 6);
  if (!noms.length) return null;
  for (const l of ["fr", "en"]) {
    try {
      const r = await fetch(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(noms.slice(0, 4).join(" "))}&srlimit=3&format=json`,
        { headers: { "user-agent": "JournalDuNon-WarRoom/1.0 (veille d'actualite)" }, signal: AbortSignal.timeout(15000) });
      const res = r.ok ? (await r.json()).query?.search || [] : [];
      for (const h of res) {
        const t = plat(h.title);
        if (!noms.some((n) => t.includes(plat(n)))) continue;            // sans nom propre commun : hors sujet
        const w = await wiki(h.title);
        if (w && w.extrait.length >= 300) return { titre: w.titre, extrait: w.extrait.slice(0, 1800) };
      }
    } catch {}
  }
  return null;
}

async function precedentsDyn(g, n) {
  const dossier = `${g.items.slice(0, 6).map((x) => `• ${x.titre}`).join("\n")}\n${String(g.texte || "").slice(0, 1800)}`;
  const deja = (g.precedents || []).map((f) => f.nom);
  const prop = await ia("Tu es historien et rédacteur en chef d'une émission d'actualité. Réponds en JSON valide.",
    `Dossier d'actualité :
${dossier}

Propose 0 à 2 précédents historiques RÉELS, célèbres, documentés, qui ont le MÊME MÉCANISME que ce dossier (une « preuve » ou une accusation
démentie ensuite, un démenti officiel suivi d'un aveu, une alerte minimisée, un incident monté en épingle, une attribution hâtive, etc.).
Le mécanisme doit être le même : pas un simple point commun de lieu, de pays ou de thème. Si rien ne colle vraiment, réponds [].
${deja.length ? `Déjà retenus (ne pas les redonner) : ${deja.join(" ; ")}.\n` : ""}Pour chacun : "article" = titre EXACT de son article Wikipédia (français ou anglais), "mecanisme" = le mécanisme commun en une phrase.
Réponds : {"precedents": [{"article": "…", "mecanisme": "…"}]}`, { maxTokens: 700, temperature: 0.2, tours: 2 });
  const out = [];
  for (const c of (prop.precedents || []).slice(0, 2)) {
    if (out.length >= n) break;
    const w = await wiki(String(c.article || "").trim());
    if (!w || deja.some((d) => plat(d) === plat(w.titre))) continue;
    let j;
    try {
      j = await ia("Tu es historien et vérificateur de faits. Réponds en JSON valide.",
        `Voici l'extrait OFFICIEL de l'article « ${w.titre} » :
${w.extrait}

Dossier d'actualité à rapprocher :
${dossier}

Mécanisme proposé : ${c.mecanisme}

1) "fait" : le précédent en 1 à 2 phrases françaises (45 mots max), avec sa DATE, écrit UNIQUEMENT avec ce que dit l'extrait (aucun chiffre, nom ni date qui n'y figure).
2) "pertinent" : true seulement si le dossier présente VRAIMENT le même mécanisme, sans accuser qui que ce soit.
3) "force" : 1 (parallèle discutable), 2 (bon), 3 (évident : le MÊME mécanisme, qu'un historien validerait sans hésiter). Dans le doute, 1.
   Refuse (pertinent=false) tout parallèle qui assimile des personnes actuelles à un coupable historique, ou qui compare une simple affaire judiciaire ou un fait divers à un grand scandale d'État.
4) "type" : ce que le précédent illustre, en une phrase.
5) "repere" : 1 à 3 mots-clés (minuscules) par lesquels un texte le nommerait (ex. un nom de lieu ou de personne de l'extrait).
Réponds : {"fait": "…", "pertinent": true, "force": 2, "type": "…", "repere": ["…"]}`, { maxTokens: 500, depart: 1, temperature: 0.1, tours: 2 });
    } catch { continue; }
    const fait = LATIN(String(j.fait || "").trim()), ext = plat(w.extrait), extN = chiffres(w.extrait);
    const noms = (fait.replace(/^\s*\S+/, "").match(/\b\p{Lu}[\p{L}’'-]{2,}/gu) || []).flatMap((m) => plat(m).split(" ")).filter((x) => x && !MAJ_COURANTS.has(x));
    const repere = (Array.isArray(j.repere) ? j.repere : []).map((x) => plat(x)).filter((x) => x.length >= 3 && (ext.includes(x) || plat(fait).includes(x))).slice(0, 3);
    const sain = j.pertinent === true && Number(j.force) >= 3 && fait.length >= 40 && /\b(1[5-9]|20)\d\d\b/.test(fait) && repere.length
      && chiffres(fait).every((x) => extN.includes(x)) && noms.every((x) => ext.includes(x)) && !NOUS.test(fait);
    log(`    précédent hors catalogue « ${w.titre} » : ${sain ? "retenu" : "écarté"}${sain ? "" : j.pertinent === false ? " (parallèle non pertinent)" : " (non vérifiable dans la page)"}`);
    if (sain) out.push({ nom: w.titre, repere, mots: [], forts: [], type: String(j.type || c.mecanisme || "").trim(), fait: `${fait} (Source : Wikipédia, article « ${w.titre} ».)`, obligatoire: Number(j.force) >= 3, dynamique: true });
  }
  return out;
}
const contient = (txt, mot) => (" " + txt + " ").includes(" " + mot + " ");
// score d'une fiche pour un dossier : nombre de « mots » trouvés, à condition qu'au moins un mot « fort » (le thème précis) y soit
function precedentsPour(g) {
  const txt = plat(`${g.items.map((x) => `${x.titre} ${x.resume || ""}`).join(" ")} ${String(g.texte || "").slice(0, 4000)}`);
  return catalogue().map((f) => {
    const forts = f.forts.filter((m) => contient(txt, m)).length;
    const mots = f.mots.filter((m) => contient(txt, m)).length;
    return { f, score: forts ? mots + forts : 0 };
  }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, 2)
    .map((x) => ({ ...x.f, obligatoire: x.score >= 5 }));
}
const cite = (texte, f) => f.repere.some((r) => contient(plat(texte), r));
const ALIAS = { pologne: "poland polish", iran: "iranian tehran", "israël": "israel israeli", israel: "israeli", russie: "russia russian moscow", moscou: "moscow kremlin",
  ukraine: "ukrainian kyiv kiev", "états-unis": "us usa washington american", chine: "china chinese beijing", "yémen": "yemen houthi houthis", houthis: "houthi yemen",
  liban: "lebanon hezbollah", syrie: "syria syrian", gaza: "gaza palestinian hamas", "arabie": "saudi riyadh", danemark: "denmark danish copenhagen",
  allemagne: "germany german berlin", otan: "nato", turquie: "turkey turkish ankara", inde: "india indian", "corée": "korea korean", venezuela: "venezuelan",
  poutine: "putin", netanyahou: "netanyahu", "zelensky": "zelenskyy zelensky", trump: "trump", macron: "macron", xi: "xi jinping", "égypte": "egypt", irak: "iraq iraqi",
  afghanistan: "afghan taliban", soudan: "sudan", "mali": "mali", niger: "niger", "algérie": "algeria", maroc: "morocco", "tunisie": "tunisia" };
function autresPour(g, pool) {
  if (!pool?.length) return [];
  const titres = g.items.map((x) => `${x.titre} ${x.resume || ""}`).join(" ");
  const noms = new Set((titres.match(/(?<!\p{L})\p{Lu}[\p{L}'’-]{1,}/gu) || []).map((m) => plat(m)).filter((w) => w.length >= 2 && !MAJ_COURANTS.has(w)));
  const cles = new Set();
  for (const w of noms) { cles.add(w); for (const [k, v] of Object.entries(ALIAS)) if (plat(k) === w) v.split(" ").forEach((x) => cles.add(x)); }
  if (!cles.size) return [];
  const sc = pool.map((x) => { const m = new Set(plat(`${x.titre} ${x.resume || ""}`).split(" ")); return [x, [...cles].filter((k) => m.has(k)).length]; })
    .filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]);
  const vus = new Set(), out = [];
  for (const [x] of sc) { if (vus.has(x.source)) continue; vus.add(x.source); out.push(x); if (out.length >= 4) break; }
  return out;
}

// étiquettes de plan que certains modèles écrivent dans le texte (« Mini-hook : », « Punchline : », « Question ouverte : »…) : retirées
const ETIQ = /(^|[.!?…]\s+)(?:mini[\s‑-]?hook|hook|accroche|punchline|chute|question ouverte|question au public|question|d[ée]cryptage|mon analyse|l'analyse|analyse indign[ée]e|analyse|angle|les faits|faits|conclusion|le contexte|contexte|le d[ée]roul[ée]ment|d[ée]roul[ée]ment|contre[\s-]?lecture)\s*:\s*/gi;
// majuscule après un point… sauf après une initiale ou une abréviation (« Florian M. soit jugé », « M. Dupont », « Mme. »)
const ABREV = /(?:^|\s)(?:\p{Lu}|M|Mme|Mlle|Dr|Pr|St|Ste|av|J\.-C|etc)\.\s+$/u;
const sansEtiquettes = (t) => { const x = String(t).replace(ETIQ, "$1");
  return x.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (m, a, c, i) => (a && ABREV.test(x.slice(Math.max(0, i - 12), i + a.length)) ? m : a + c.toUpperCase())); };
// un titre d'article recopié en tête de phrase SANS point (« … dès janvier 2027 Le 24 novembre, … ») : le point est remis ;
// et une majuscule mise à tort après une initiale (« Florian M. Soit jugé ») est corrigée
function recoller(texte, titres = []) {
  let t = String(texte);
  for (const ti of titres) {
    const x = String(ti || "").replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, "").trim();
    if (x.split(/\s+/).length < 4) continue;
    const k = t.indexOf(x);
    if (k >= 0 && /^\s+\p{Lu}/u.test(t.slice(k + x.length))) t = t.slice(0, k + x.length).replace(/[,;:]$/, "") + "." + t.slice(k + x.length);
  }
  return t.replace(/(\s\p{Lu}\.\s+)(Soit|Est|A|Sera|Avait|Aurait|Devra|Doit|Qui|Que|Dont|Et|Ou|Mais|Pour|Dans|Sur|Avec)\b/gu, (m, a, w) => a + w.toLowerCase());
}

// ---------------------------------------------------------------- 3bis) garde-fous contre l'invention
// a) une citation entre guillemets qui ne figure pas dans les sources = phrase retirée (les expressions courtes, ≤ 3 mots, restent)
const plat = (x) => String(x).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’'‘`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
function citationsSures(texte, source, quiet = false) {
  const src = plat(source);
  const phr = texte.split(/(?<=[.!?…])\s+/);
  const ok = phr.filter((p) => [...p.matchAll(/[«“"]\s*([^»”"]{3,}?)\s*[»”"]/g)].every((m) => m[1].split(/\s+/).length <= 3 || src.includes(plat(m[1]))));
  if (ok.length < phr.length && !quiet) log(`    ${phr.length - ok.length} phrase(s) retirée(s) : citation absente des sources`);
  return ok.join(" ");
}
// un extrait « copié » par l'IA est retrouvé dans les sources même s'il diffère un peu (accents, apostrophes, un mot changé) :
// il faut une fenêtre du texte source où au moins 85 % de ses mots se retrouvent. Moins de 6 mots = pas une preuve.
function extraitPos(extrait, source) {
  const e = plat(extrait || "").split(" ").filter(Boolean);
  if (e.length < 4) return -1;
  const s = plat(source).split(" ");
  const L = e.length;
  for (let i = 0; i + L <= s.length; i++) if (s[i] === e[0] && s.slice(i, i + L).join(" ") === e.join(" ")) return i;   // copie exacte (≥ 4 mots : un titre court suffit)
  if (L < 6) return -1;
  const need = Math.ceil(L * 0.85);
  for (let i = 0; i + L <= s.length + 2; i++) {
    const win = new Map();
    for (const w of s.slice(i, i + L + 2)) win.set(w, (win.get(w) || 0) + 1);
    let ok = 0;
    for (const w of e) { const c = win.get(w); if (c) { ok++; win.set(w, c - 1); } }
    if (ok >= need) return i;
  }
  return -1;
}
const extraitTrouve = (extrait, source) => extraitPos(extrait, source) >= 0;
// les noms propres et les chiffres d'une phrase factuelle doivent se trouver AUTOUR de sa preuve (± 80 mots) : une preuve exacte sur
// la Grèce ne peut pas servir à une phrase qui dit « Strasbourg » (la ville a été déplacée par l'IA)
function prochesDeLaPreuve(phrase, preuve, source) {
  const i = extraitPos(preuve, source);
  if (i < 0) return false;
  // zone = la (ou les) phrase(s) des sources où se trouve la preuve
  const L = plat(preuve).split(" ").filter(Boolean).length;
  const zone = [];
  let k = 0;
  for (const ph of String(source).split(/(?<=[.!?…])\s+|\n+/)) {
    const w = plat(ph).split(" ").filter(Boolean);
    if (k + w.length > i && k < i + L) zone.push(...w);
    k += w.length;
  }
  const zw = new Set(zone), zj = zone.join(" ");
  const noms = (String(phrase).replace(/^\s*\S+/, "").match(/\b\p{Lu}[\p{L}’'-]{2,}/gu) || []).flatMap((m) => plat(m).split(" ")).filter((w) => w && !MAJ_COURANTS.has(w));
  const nums = chiffres(phrase).filter((n) => !/^(19|20)\d\d$/.test(n));
  return noms.every((w) => zw.has(w)) && nums.every((n) => zj.replace(/ /g, "").includes(n));
}

// tout nom propre d'une phrase factuelle (personne, ville, organisation…) doit exister dans les sources
const MAJ_COURANTS = new Set("le la les un une des de du et en au aux il elle ils elles je vous on ce cette ces son sa ses leur leurs selon pour par dans sur avec sans mais ou donc or ni car quand alors depuis après avant pendant face entre lors chaque tout tous toute toutes aucun aucune plus moins très trop bien mal regardez attention voici voilà enfin ensuite puis bref oui non france etat état république gouvernement ministre président".split(" "));
function nomsConnus(phrase, source) {
  const src = new Set(plat(source).split(" "));
  const mots = String(phrase).replace(/^\s*\S+/, "").match(/\b\p{Lu}[\p{L}’'-]{2,}/gu) || [];
  return mots.every((m) => { const w = plat(m).split(" "); return w.every((x) => MAJ_COURANTS.has(x) || src.has(x)); });
}

// b) vérification des faits par un AUTRE fournisseur que celui qui a écrit : chaque phrase qui affirme un fait absent des sources
//    (ou contredit par elles) est corrigée d'après les sources, ou retirée.
// victimes = le dossier touche des morts, blessés, enfants, violences sexuelles ou sinistrés : aucun humour toléré.
// verifierPhrases renvoie null si la vérification n'a pas pu se faire (IA saturée), sinon
//   { sorties: [phrase gardée | phrase recadrée | null], faits, avis, retirees, corrigees, refusees: [phrases retirées] }.
const MARQUE_AVIS = /^(le non du jour|la position du jour|et si|coïncidence|je ne (dis|vous dis) pas|posez-vous|à qui profite|à mon (sens|avis)|je (pense|crois|trouve|me demande|constate|vous laisse|dis non)|ce qui me révolte|selon moi|pour moi|franchement|il me semble|j'ai l'impression)/i;
async function verifierPhrases(phr, source, depart, victimes = false) {
  if (!phr.length) return { sorties: [], faits: 0, avis: 0, retirees: 0, corrigees: 0, refusees: [] };
  if (reste() < 5 * 60e3) return null;
  // PREUVE OBLIGATOIRE, phrase par phrase : chaque phrase factuelle doit être appuyée par un extrait EXACT des sources, retrouvé
  // mécaniquement. Pas de preuve retrouvée = phrase retirée (ou remplacée par une version qui colle à la preuve). Les liens de cause,
  // les lieux (ville, département, région), les qualifications et les déductions sont des faits comme les autres. Un avis, une
  // punchline ou une phrase d'humour qui glisse un fait (« la police débarque au siège… », « votre argent est en danger ») est un fait.
  let j;
  try {
    j = await ia("Tu es vérificateur de faits (fact-checker) et juriste pour une émission d'actualité. Réponds en JSON valide.",
      `Voici les phrases numérotées d'un texte, puis ses SOURCES. Pour CHAQUE phrase, donne :
- "type" : "fait" (affirme quelque chose sur le réel : événement, action, présence, nom, chiffre, date, lieu, cause, conséquence,
  qualification, comparaison, déduction, menace, danger), "avis" (jugement personnel SANS aucun fait nouveau), "question", ou "humour" ;
- "affirme_un_fait" : true si la phrase, même présentée comme un avis, une image, une punchline ou de l'humour, laisse entendre
  quelque chose sur le réel qui n'est pas déjà prouvé ailleurs (une action, une présence, un danger, une culpabilité) ; sinon false ;
- pour un "fait" (ou "affirme_un_fait": true) : "preuve" = un extrait COPIÉ MOT POUR MOT des sources (4 à 50 mots ; un titre d'article
  entier peut servir) qui prouve TOUT ce
  que dit la phrase — y compris le lieu exact, le lien de cause à effet, la qualification juridique. Si la phrase dit PLUS que ce que
  prouve l'extrait, donne "correction" = la phrase réécrite pour ne dire QUE ce que prouve l'extrait (même ton). Sans extrait : "preuve": "".
- une personne non condamnée présentée comme coupable, même par une image (« vendre les clés », « ceux qui l'ont brisée ») :
  "type": "fait", "correction" avec « accusé », « soupçonné », « mis en examen », ou "preuve": "" si impossible.
- une phrase qui renvoie à quelque chose que le texte n'a pas dit (« cette baisse », « ce décalage » sans antécédent) : "type": "fait", "preuve": "".${victimes ? `
- CE TEXTE PARLE DE VICTIMES : toute ironie, sarcasme ou moquerie est "humour" ; toute description explicite d'actes sexuels est
  un "fait" dont la "correction" n'utilise que les mots du droit (« viol », « agression sexuelle »).` : ""}
Réponds : {"phrases": [{"n": 0, "type": "fait", "affirme_un_fait": true, "preuve": "…", "correction": "…"}, …]} — une entrée par phrase.

PHRASES :
${phr.map((p, i) => `[${i}] ${p}`).join("\n")}

SOURCES :
${source}`, { maxTokens: 6000, depart, temperature: 0.1, tours: 2 });
  } catch (e) { log(`    vérification des faits impossible pour l'instant (${String(e.message).slice(0, 80)}) : nouvel essai à la fin`); return null; }
  const res = new Map((j.phrases || []).filter((x) => x && isFinite(x.n)).map((x) => [Number(x.n), x]));
  if (res.size < phr.length * 0.8) { log(`    vérification incomplète (${res.size}/${phr.length} phrases) : nouvel essai à la fin`); return null; }
  const prouve = (x) => extraitTrouve(x, source);
  const sure = (x) => x && !NOUS.test(x) && !QUEMANDE.test(x) && !HORS_DOSSIER.test(x) && chiffresSurs(x, source) && citationsSures(x, source, true) === x;
  const st = { sorties: [], faits: 0, avis: 0, retirees: 0, corrigees: 0, refusees: [] };
  const non = (p) => { st.sorties.push(null); st.retirees++; st.refusees.push(p); };
  phr.forEach((p, i) => {
    const r = res.get(i);
    const type = String(r?.type || "").toLowerCase();
    const question = type === "question" || /\?\s*$/.test(p);
    if (!r) { if (question || MARQUE_AVIS.test(p)) { st.sorties.push(p); st.avis++; } else non(p); return; }
    // un avis / une image / de l'humour sans fait : gardé (sauf humour sur un dossier à victimes), à condition de n'introduire
    // ni nom propre ni chiffre absents des sources (contrôle mécanique, indépendant de l'IA)
    if ((type === "question" || type === "avis" || type === "humour") && r.affirme_un_fait !== true) {
      if (type === "humour" && victimes) return non(p);
      if (!nomsConnus(p, source) || !chiffresSurs(p, source)) return non(p);
      st.sorties.push(p); if (!question) st.avis++; return;
    }
    // fait : preuve exacte obligatoire
    if (!prouve(r.preuve)) return non(p);
    const c = String(r.correction || "").trim();
    if (c && c !== p) { if (sure(c) && nomsConnus(c, source) && prochesDeLaPreuve(c, r.preuve, source)) { st.sorties.push(c); st.corrigees++; st.faits++; } else non(p); return; }
    if (!nomsConnus(p, source) || !prochesDeLaPreuve(p, r.preuve, source)) return non(p);
    st.sorties.push(p); st.faits++;
  });
  return st;
}
const phrases = (t) => String(t).split(/(?<=[.!?…])\s+/).filter(Boolean);
// une phrase qui redit une autre phrase du même texte (≥ 75 % de ses mots pleins s'y retrouvent) : la plus courte est retirée
function sansRedites(texte) {
  const ps = phrases(texte), M = ps.map((p) => new Set(plat(p).split(" ").filter((w) => w.length >= 4)));
  const out = ps.filter((p, i) => {
    if (M[i].size < 4 || /\?\s*$/.test(p)) return true;
    return !ps.some((q, k) => k !== i && M[k].size >= M[i].size && (M[k].size > M[i].size || k > i) && [...M[i]].filter((w) => M[k].has(w)).length >= Math.ceil(M[i].size * 0.75));
  });
  return out.join(" ");
}
// Renvoie { texte, ok, faits, avis, retirees, refusees } : ok = false si la vérification n'a pas pu se faire (nouvel essai à la fin,
// sinon dossier retiré).
async function verifierFaits(texte, source, depart, victimes = false) {
  const st = await verifierPhrases(phrases(texte), source, depart, victimes);
  if (!st) return { texte, ok: false, faits: 0, avis: 0, retirees: 0, refusees: [] };
  if (st.retirees || st.corrigees) log(`    vérification des faits : ${st.corrigees} phrase(s) recadrée(s) sur la preuve, ${st.retirees} retirée(s) (sans preuve)`);
  return { texte: st.sorties.filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim(), ok: true, faits: st.faits, avis: st.avis, retirees: st.retirees, refusees: st.refusees };
}
// un dossier « amputé » (faits retirés, opinions qui dominent) se lit mal : il est réécrit, ou retiré
const maigre = (v) => v.ok && (v.faits < 2 || v.avis > v.faits);
const ampute = (v) => v.ok && (maigre(v) || v.faits < 3 || v.retirees >= 2);

// c) MÉDIAS RECONNUS : si aucun ne rapporte le sujet, il n'est pas écarté (journalisme citoyen), mais le texte dit clairement qui
//    est la seule source (« selon X, seul à le rapporter à ce stade ») — la responsabilité de l'information reste à cette source.
const RECONNUS = ["afp", "reuters", "bfmtv", "bfm tv", "rmc", "tf1 info", "tf1info", "franceinfo fr", "lemonde", "lefigaro", "leparisien", "ouest-france", "associated press", "le monde", "franceinfo", "france info", "france 24", "france24", "rfi", "bfm", "le figaro",
  "liberation", "20 minutes", "20minutes", "ouest france", "l'express", "lexpress", "le point", "le parisien", "europe 1", "mediapart", "tf1",
  "france 3", "france 2", "france televisions", "francetvinfo", "ici.fr", "france bleu", "sud ouest", "la depeche", "le telegramme",
  "la voix du nord", "le progres", "nice matin", "corse matin", "la nouvelle republique", "lanouvellerepublique", "les echos", "la tribune",
  "courrier international", "l'obs", "nouvel obs", "marianne", "le jdd", "cnews", "lci", "rtl", "france inter", "le dauphine", "l'est republicain",
  "midi libre", "le republicain lorrain", "dna", "challenges", "capital", "l'opinion", "la croix", "l'humanite", "le canard enchaine",
  "public senat", "lcp", "arte", "euronews", "bbc", "cnn", "the guardian", "new york times", "nytimes", "washington post", "bloomberg",
  "financial times", "al jazeera", "le soir", "rtbf", "le temps", "le vif", "rts", "dw", "politico", "the times", "wall street journal",
  "le journal du dimanche", "la provence", "l'union", "le berry", "la montagne", "le populaire", "centre presse", "presse ocean",
  "cisa", "usgs", "gdacs", "gouv.fr", "service-public", "elysee", "interieur.gouv"];
const plat2 = (x) => plat(x).replace(/[-.]/g, " ");
const estReconnu = (nom) => { const n = ` ${plat2(nom)} `; return RECONNUS.some((r) => n.includes(` ${plat2(r)} `)); };
function seuleSource(g) {
  const noms = [...new Set(g.items.map((x) => String(x.source || "").trim()).filter(Boolean))];
  if (g.officiel || g.revendication) return null;
  if (g.nb_sources === 1) return noms.slice(0, 1);          // UNE seule source, même un grand média : toujours dit à l'antenne
  if (noms.some(estReconnu)) return null;
  return noms.slice(0, 2);
}
const listeNoms = (n) => (n.length > 1 ? `${n.slice(0, -1).join(", ")} et ${n[n.length - 1]}` : n[0] || "un seul site");

// d) jamais de sujet de suicide ou d'automutilation (encore moins sur un mineur) dans un live choc
const AUTOLYSE = /(?<!(attentats?|drones?|missions?|kamikazes?|opérations?|commandos?|bombes?|vestes?|ceintures?)[- ])\bsuicid(e|es|é|ée|és|ées|er|ait|aient|ent|ant)?\b(?! (politique|électoral|commercial|économique|collectif des))|automutil|s'est donn[ée]e? la mort|mis fin à (ses|sa) (jours|vie)|immol|(s'est|s'était|se serait|s'être|s'étant) (en fait |lui-même |elle-même )*(inflig[ée]+s?|fait) (lui-même |elle-même )?(le |les |un |une |des |ses |ces |cette |ce )?(coup|blessure|plaie|entaille|lésion|mutilation)s?|(s'est|se serait|s'être) (lui-même |elle-même )?(poignard|tailladé|scarifi)/i;
const sujetAutolyse = (g) => AUTOLYSE.test(plat0(g.items.map((x) => `${x.titre} ${x.resume || ""}`).join(" ")) + " " + plat0(String(g.texte || "").slice(0, 4000)));
const plat0 = (x) => String(x).replace(/[’‘`]/g, "'").replace(/\s+/g, " ").toLowerCase();

// e) caractères d'un autre alphabet glissés par un modèle (arabe, cyrillique, chinois…) : retirés du texte lu
const LATIN = (s) => String(s).replace(/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\s]|[\u0370-\u03FF\u0400-\u052F\u0590-\u08FF\u0900-\u0DFF\u3000-\u9FFF\uAC00-\uD7AF\uFE70-\uFEFF]/gu, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?…])/g, (m, c) => (/[;:!?]/.test(c) ? " " + c : c)).trim();

// ---------------------------------------------------------------- 3bis) écrire un dossier
const NOUS = /\b(nous|notre|nos)\b/i;
const HORS_DOSSIER = /\bbienvenue\b|dans les commentaires|en commentaire|\b(aucune|sans|pas d')\s*(ironie|humour)\b|\bpas de (blague|second degré)\b/i;   // consignes recopiées par l'IA : jamais lues à l'antenne     // l'accueil est dans l'ouverture seulement ; questions ouvertes, sans consigne
const ANGLES = [               // des ANGLES D'ANALYSE (opinion assumée) — jamais un prétexte pour inventer un fait « caché »
  "qui gagne, qui perd",
  "ton analyse de ce que ça révèle (présentée comme ton avis)",
  "la conséquence concrète pour le public",
  "le schéma qui se répète (seulement s'il est évident, sans inventer de précédent précis)",
  "la question qui fâche",
  "le détail le plus frappant DES SOURCES",
];
const QUEMANDE = /\b(likez|liker|partagez|abonnez|abonnez-vous|mettez un pouce|lâchez un like)\b|[ée]crivez\s+\S+\s+(dans le chat\s+)?si\b|tapez\s+\S+\s+si\b/i;
// nombres ÉCRITS EN LETTRES (« trois mille », « deux mille seize ») convertis en chiffres avant tout contrôle : sinon un chiffre
// inventé écrit en toutes lettres passerait la vérification. « million(s) / milliard(s) » restent des mots (« 3 millions »).
const NB = { zero: 0, "zéro": 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13,
  quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100, cents: 100, mille: 1000 };
const RE_NB = new RegExp(`(?<![\\p{L}])(?:${Object.keys(NB).join("|")})(?:(?:[\\s-]+(?:et[\\s-]+(?=(?:un|une|onze)(?![\\p{L}])))?)(?:${Object.keys(NB).join("|")}))*(?![\\p{L}])`, "giu");
function enChiffres(s) {
  return String(s).replace(RE_NB, (m) => {
    const w = m.toLowerCase().split(/[\s-]+/).filter((x) => x !== "et");
    if (w.length === 1 && NB[w[0]] < 10) return m;          // « un », « deux »… seuls : laissés (articles, « les deux pays »)
    let total = 0, cur = 0, prev = 0;
    for (const x of w) { const v = NB[x];
      if (v === 100) cur = (cur || 1) * 100;
      else if (v === 1000) { total += (cur || 1) * 1000; cur = 0; }
      else if (v === 20 && prev === 4) cur += 76;            // quatre-vingt(s)
      else cur += v;
      prev = v; }
    return String(total + cur);
  });
}
const chiffres = (s) => (String(enChiffres(s)).match(/\d[\d\s.,]*\d|\d/g) || []).map((n) => n.replace(/[\s.,]/g, "")).filter((n) => n.length >= 2);
function chiffresSurs(texte, source) {
  const ok = new Set(chiffres(source));
  const an = String(new Date().getFullYear());
  return chiffres(texte).every((n) => ok.has(n) || n === an || n.length < 2);      // une autre année que l'année en cours doit être dans les sources
}
async function ecrireDossier(g, rang = 0, depart = 0) {
  try { return await ecrireDossier0(g, rang, depart); }
  catch (e) {
    if (String(g.texte || "").length < 3000 || reste() < 8 * 60e3) throw e;
    log(`    nouvel essai avec des sources raccourcies (${String(e.message).slice(0, 80)})`);
    return ecrireDossier0({ ...g, texte: g.texte.slice(0, Math.round(g.texte.length / 2)) }, rang, depart + 1);
  }
}
async function ecrireDossier0(g, rang = 0, depart = 0) {
  const n = g.note, rev = g.revendication, rumeur = n.categorie === "RUMEUR", seule = seuleSource(g);
  const contre = CONTRE_CATS.includes(n.categorie);
  const mots_cible = Math.round(Math.max(300, Math.min(650, 200 + g.texte.length / 25)));   // un récit avec contexte, pas une brève
  const j = await ia(`Tu écris pour un live YouTube d'actualité choc (chaîne « ${ED.chaine} »). Réponds en JSON valide.`,
    `Écris le DOSSIER ci-dessous pour le présentateur, qui le lira au prompteur.
HUMOUR NOIR : jamais aux dépens des victimes (violences sexuelles, enfants, morts, sinistrés, malades) ; il vise les puissants,
les institutions, l'absurde. Si le dossier compte des morts, des blessés, des enfants victimes ou des violences sexuelles : AUCUN
humour, aucune ironie, aucun sarcasme dans tout le dossier — ton grave et factuel. Aucune image sexuelle ou gore : les violences sexuelles se disent avec les mots du droit (« viol », « agression sexuelle »), jamais
la description des actes. Français impeccable : aucun mot inventé ou approximatif.
STYLE « JOURNAL DU NON » (c'est ce qui fait venir le public, sinon il part) : du FEU. Indignation assumée, ironie mordante contre
les puissants, phrases courtes qui claquent, rythme oral, interpellation directe (« vous », « posez-vous la question »). JAMAIS le ton
tiède d'une dépêche ni la version des chaînes d'info répétée telle quelle.
C'EST UN RÉCIT, PAS UNE BRÈVE : le public doit COMPRENDRE comment on en est arrivé là. Déroulé obligatoire, sans titres ni étiquettes :
1) ACCROCHE (1 à 2 phrases) : le fait le plus fort, tout de suite ;
2) LE CONTEXTE (« pour comprendre, il faut revenir en arrière… ») : qui sont les acteurs, ce qui s'est passé AVANT, depuis quand,
   l'enjeu — tiré des sources (y compris la partie « CONTEXTE » si elle existe), avec les dates ;
3) LE DÉROULEMENT : les faits dans l'ordre chronologique jusqu'à aujourd'hui, chaque étape reliée à la précédente (« c'est là que… »,
   « trois jours plus tard… », « et c'est précisément ce qui… ») ;
4) ${contre ? `LA CONTRE-LECTURE (obligatoire ici) : « voilà la version qu'on vous sert partout… maintenant, à qui profite ? » — ce que disent
les AUTRES LECTURES listées dans les sources (presse étrangère, indépendante, l'autre camp), CITÉES PAR LEUR NOM (« selon Al Jazeera… »),
et/ou ${g.precedents?.length ? `le PRÉCÉDENT HISTORIQUE retenu dans les sources (${g.precedents.map((f) => f.nom).join(" ; ")}) — en expliquant en une phrase le parallèle${g.precedents.some((f) => f.obligatoire) ? ` (OBLIGATOIRE ici : ${g.precedents.filter((f) => f.obligatoire).map((f) => f.nom).join(" ; ")})` : ""} ; AUCUN autre précédent historique` : "AUCUN précédent historique (aucun ne colle à ce dossier : n'en cite pas)"} ; une hypothèse
dérangeante est permise si elle est présentée comme TA question ou comme ce qui circule (« et si… ? », « coïncidence ? », « je ne dis
pas que c'est vrai, je dis que la question se pose »), jamais comme un fait établi ; ` : `L'ANGLE qui dérange — « ${ANGLES[rang % ANGLES.length]} » — vu depuis le public, pas depuis les institutions ; `}
5) MON ANALYSE : l'indignation NAÎT des faits racontés juste avant (« et c'est là que ça devient insupportable : … »), elle vise
   les puissants, les institutions, l'hypocrisie, le deux poids deux mesures — ancrée dans un fait précis du récit (un délai, un écart,
   une contradiction) ; jamais une formule plaquée, jamais un slogan de plateau télé ; JAMAIS les victimes, JAMAIS une personne non
   condamnée présentée comme coupable ; dossier avec victimes : la colère vise le système, jamais une personne ;
6) UNE question ouverte qui pique, qui découle du récit.
N'ÉCRIS PAS « ${ED.signature} » dans ce dossier (il est réservé à la fin du live).
Le dossier est lu au milieu du live : pas de « Bienvenue », pas de salut, pas de « dans les commentaires ».
${ED.contexte || `HORS DU CONTEXTE : jamais « nous », « notre », « nos » ; dis « vous », « je ». Ne parle de la France ou des Français QUE si le sujet
les concerne directement (jamais de rapprochement forcé).`}
JAMAIS « likez », « partagez », « abonnez-vous », ni « écrivez X si… / tapez X si… ».
EXACTITUDE (protection juridique) : n'utilise QUE les faits des sources ci-dessous ; aucun chiffre, nom, date, citation ou détail
inventé, aucune « révélation » que les sources ne contiennent pas. Ton analyse est permise, mais présentée comme ton avis (« je pense »,
« à mon sens »), jamais comme un fait. Une citation entre guillemets doit figurer MOT POUR MOT dans les sources.
Une personne non condamnée n'est JAMAIS « meurtrier », « coupable », « violeur » : « accusé », « poursuivi », « soupçonné ».
Si les sources désignent la même affaire ou la même personne de plusieurs façons, c'est UNE seule affaire (ne la dédouble pas). Une
accusation reste une accusation (« selon… », « soupçonné », « présumé »).${rev ? ` C'est une REVENDICATION de cybercriminels sur leur site de
fuite, NON CONFIRMÉE : dis-le clairement (« revendique », « affirme », « rien ne confirme pour l'instant »).` : ""}${rumeur ? ` C'est une RUMEUR /
théorie qui circule : raconte ce qui circule et pourquoi ça prend, puis ce qu'on sait vraiment d'après les vérifications.` : ""}${seule ? `
SOURCE UNIQUE : aucun grand média ne rapporte ce sujet, seulement ${listeNoms(seule)}. Attribue CHAQUE fait à cette source (« selon
${seule[0]} », « d'après ${seule[0]} »), au conditionnel, et dis clairement qu'aucune autre rédaction ne le confirme à ce stade.` : ""}
VALEUR AJOUTÉE (obligatoire) : le public a déjà vu les titres au JT et chez les autres youtubeurs. Ne résume PAS la dépêche :
apporte au moins UN élément qu'ils n'ont pas eu, tiré des SOURCES ci-dessous — le détail enterré en bas d'article, le chiffre que
personne ne met en avant, ce que dit la presse étrangère (si elle figure dans les sources), une contradiction entre deux sources,
ou le lien avec un autre fait des sources — puis la question que personne ne pose (ton avis, présenté comme tel).
LONGUEUR : environ ${mots_cible} mots.
ÉCRAN (affiché derrière le présentateur) : titre en 3 à 7 mots ; 3 faits clés de 4 à 10 mots chacun, dans l'ordre où tu en parles ;
un chiffre clé SEULEMENT s'il est dans les sources ET mesure la gravité (morts, blessés, victimes, montant, peine,
nombre de personnes touchées) — jamais un âge, une date ou un numéro ; sinon null ; gravité 1 à 5.
Réponds : {"titre_ecran": "…", "texte": "…", "faits_cles": ["…","…","…"], "chiffre_cle": {"valeur": "…", "libelle": "…"} ou null,
"gravite": 4, "lieu": "Ville, Pays", "accroche_teaser": "une phrase de 12 mots max pour annoncer ce dossier plus tôt dans le live"}

CATÉGORIE : ${n.categorie} — PAYS : ${n.pays || "?"}
SOURCES (${g.nb_sources}) :
${g.texte}`, { maxTokens: 3500, depart, temperature: 0.45 });
  const nettoyer = (brut) => {
    // traces de mise en forme de certains modèles : « \\n » écrit en toutes lettres, renvois [3], puces « - » → retirés
    let tx = LATIN(sansEtiquettes(String(brut || "").replace(/\\n/g, " ").replace(/\s*\[\d{1,2}\]/g, "").replace(/(^|\n|[.!?…:])\s*[-•]\s+/g, "$1 ").replace(/\s*\n+\s*/g, " ").trim()));
    // contrôle : phrases avec « nous », quémande de likes, ou chiffre absent des sources → retirées
    const phr = tx.split(/(?<=[.!?…])\s+/);
    const bonnes = phr.filter((p) => !NOUS.test(p) && !QUEMANDE.test(p) && !HORS_DOSSIER.test(p) && chiffresSurs(p, g.texte));
    if (bonnes.length < phr.length) log(`    ${phr.length - bonnes.length} phrase(s) retirée(s) (chiffre absent des sources, « nous », salut ou appel au like)`);
    return citationsSures(bonnes.join(" "), g.texte);
  };
  const victimes = ["FAIT DIVERS", "ACCIDENT", "CATASTROPHE"].includes(n.categorie)
    || /\b(morts?|tu[ée]e?s?|décéd|bless|victime|enfant|bébé|fillette|garçonnet|mineur|viol|agression sexuelle|sinistr|évacu)/i.test(g.texte.slice(0, 3000));
  let texte = nettoyer(j.texte);
  let v = await verifierFaits(texte, g.texte, depart + 1, victimes);
  // DOSSIER AMPUTÉ par le contrôle (faits sans preuve retirés, opinions qui dominent, phrases orphelines) : il n'est pas lu tel
  // quel. Il est RÉÉCRIT une fois, en sachant quelles phrases ont été refusées, puis revérifié ; la meilleure version est gardée.
  if (ampute(v) && reste() > 10 * 60e3) {
    log(`    dossier amputé par le contrôle (${v.faits} fait(s) prouvé(s), ${v.retirees} phrase(s) refusée(s)) : réécriture`);
    try {
      const j2 = await ia(`Tu écris pour un live YouTube d'actualité choc (chaîne « ${ED.chaine} »). Réponds en JSON valide.`,
        `Réécris ce dossier. Le contrôle des faits a REFUSÉ les phrases ci-dessous : elles affirmaient des choses que les sources ne
prouvent pas, ou renvoyaient à une information absente. Cette fois, CHAQUE phrase factuelle doit reprendre une information écrite
noir sur blanc dans les sources (mêmes lieux, mêmes chiffres, mêmes qualifications) ; tes avis sont permis mais présentés comme tels
(« je pense », « à mon sens ») et sans aucun fait nouveau ; une personne non condamnée est « accusée », « soupçonnée », « mise en examen ».
Le texte doit se comprendre seul : présente les faits avant de les commenter. Au moins 3 faits sourcés si les sources le permettent, plus de faits que d'avis.${seule ? `
SOURCE UNIQUE (${listeNoms(seule)}) : chaque fait est attribué à cette source, au conditionnel.` : ""}
Mêmes règles qu'avant : jamais « nous / notre / nos », jamais « likez / partagez / abonnez-vous », pas de « Bienvenue »,
${victimes ? "AUCUN humour (dossier avec victimes), " : "humour noir jamais aux dépens des victimes, "}un RÉCIT : accroche, contexte (ce qui s'est passé avant),
déroulement chronologique, puis ton analyse indignée qui découle des faits (jamais contre une victime ni contre une personne non
condamnée, jamais « ${ED.signature} »${GOLFE ? ", jamais contre la personne d'un souverain du Golfe ou de sa famille" : ""}), puis une question ouverte au public à la fin.
Environ ${Math.max(220, Math.min(450, 60 + 35 * Math.max(4, v.faits + 3)))} mots.
Réponds : {"texte": "…"}

TEXTE PRÉCÉDENT (après contrôle) :
${v.texte}

PHRASES REFUSÉES :
${v.refusees.map((x) => `- ${x}`).join("\n")}

SOURCES :
${g.texte}`, { maxTokens: 3000, depart, temperature: 0.3 });
      const t2 = nettoyer(j2.texte);
      const v2 = t2 ? await verifierFaits(t2, g.texte, depart + 1, victimes) : null;
      if (v2?.ok && !maigre(v2) && (v2.faits > v.faits || maigre(v) || v2.retirees < v.retirees)) { v = v2; log(`    réécriture gardée (${v2.faits} fait(s) prouvé(s), ${v2.retirees} refusée(s))`); }
    } catch (e) { log(`    réécriture impossible (${String(e.message).slice(0, 80)})`); }
  }
  texte = sansRedites(v.texte);
  if (contre && v.ok) texte = await controlerPrecedents(texte, g, depart, victimes);
  if (maigre(v)) throw new Error(`trop peu de faits prouvés (${v.faits} fait(s), ${v.avis} avis) : dossier retiré`);
  // source unique : la précision est dite à l'antenne, mot pour mot, quoi qu'ait écrit l'IA
  if (seule && v.ok) texte = `Précision importante : cette information n'est rapportée que par ${listeNoms(seule)}, aucune autre rédaction ne la confirme à ce stade. ${texte}`;
  const cle = j.chiffre_cle && j.chiffre_cle.valeur && chiffresSurs(j.chiffre_cle.valeur, g.texte) ? { valeur: String(j.chiffre_cle.valeur).slice(0, 18), libelle: String(j.chiffre_cle.libelle || "").slice(0, 60) } : null;
  // l'ÉCRAN aussi ne dit que ce que dit le texte vérifié : un fait clé ou un titre dont les mots ne sont pas dans le texte vérifié
  // (ou les sources, pour le titre) est écarté ; le titre retombe alors sur le titre réel de l'article
  const motsDe = (s) => plat(s).split(" ").filter((w) => w.length >= 4);
  const couvert = (s, ref) => { const r = new Set(motsDe(ref)); const m = motsDe(s); return m.length > 0 && m.filter((w) => r.has(w)).length >= Math.ceil(m.length * 0.8); };
  const faits = (Array.isArray(j.faits_cles) ? j.faits_cles : []).map((x) => LATIN(String(x)).slice(0, 80)).filter((x) => x && chiffresSurs(x, g.texte) && couvert(x, texte)).slice(0, 3);
  const ref = `${texte} ${g.items.map((x) => x.titre).join(" ")}`;
  // un titre d'écran n'accuse JAMAIS (présomption d'innocence) : « taupe », « coupable », « meurtrier »… → titre réel de l'article
  const ACCUSE = /\b(taupe|tra[îi]tre|coupable|meurtri[eè]re?|assassin|violeur|p[ée]dophile|escroc|menteur|menteuse|corrompue?|voleur|voleuse|criminel(le)?|mafieux|complice)s?\b/i;
  const titreOk = j.titre_ecran && !ACCUSE.test(j.titre_ecran) && (() => { const m = motsDe(j.titre_ecran), r = new Set(motsDe(ref)); return m.length > 0 && m.filter((w) => r.has(w)).length >= Math.ceil(m.length * 0.5); })();
  const fr = g.items.find((x) => x.langue === "fr" || /[éèàùçêâîô]|\b(le|la|les|des|du|une|est|dans|pour)\b/i.test(x.titre));
  const titreArticle = () => {           // titre réel de l'article, rendu lisible : sans « DIRECT. », sans nom du média, coupé sur un mot
    let s = (fr || g.items[0]).titre.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, "").replace(/^\s*(DIRECT|VIDÉO|VIDEO|INFO [^.:]{1,25}|EXCLUSIF|PHOTOS?|ENQUÊTE|TÉMOIGNAGE)\s*[.:]\s*/i, "");
    const [av, ap] = s.split(/\s+:\s+/);
    if (ap && av.split(/\s+/).length >= 3) s = av; else if (ap && ap.split(/\s+/).length >= 3) s = ap;
    const w = s.split(/\s+/); if (w.length > 9) s = w.slice(0, 8).join(" ").replace(/[,;:]$/, "") + "…";
    return s.replace(/^["«»“”\s]+|["«»“”\s]+$/g, "");
  };
  texte = recoller(texte, g.items.map((x) => x.titre));
  if (texte.split(/\s+/).length < 110) throw new Error("dossier trop court après contrôle (moins de 110 mots : une brève, pas un récit)");
  return {
    aVerifier: !v.ok, _src: g.texte, _victimes: victimes, _seule: seule,
    categorie: n.categorie, choc: Number(n.choc) || 0, gravite: Math.max(1, Math.min(5, Number(j.gravite) || Math.round((Number(n.choc) || 5) / 2))),
    titre: LATIN(String((titreOk && j.titre_ecran) || (fr ? titreArticle() : (!ACCUSE.test(j.titre_ecran || "") && j.titre_ecran)) || titreArticle())).slice(0, 70), lieu: String(j.lieu || [n.ville, n.pays].filter(Boolean).join(", ")).slice(0, 60),
    pays: n.pays || "", faits, chiffre: cle, texte, teaser: String(j.accroche_teaser || "").slice(0, 120), revendication: !!rev, rumeur, unique: seule ? seule.length : 0,
    sources: [...new Map([...g.items.filter((x) => x.source).map((x) => [x.source, { nom: x.source, url: x.url || "" }]), ...(g.autres || []).filter((x) => texte.includes(x.nom)).map((x) => [x.nom, x])]).values()].slice(0, 8),
  };
}

// Contrôle des précédents après écriture :
//  a) un précédent du catalogue cité alors qu'il n'a PAS été retenu pour ce dossier → ses phrases sont retirées (aucune IA) ;
//  b) un précédent retenu est jugé par une AUTRE IA que l'autrice : parallèle valable ou non ; non → ses phrases sont retirées ;
//  c) un précédent OBLIGATOIRE oublié → 1 à 2 phrases ajoutées (revérifiées) juste avant « Le NON du jour ».
async function controlerPrecedents(texte, g, depart, victimes) {
  const retenus = g.precedents || [];
  const sans = (tx, f) => phrases(tx).filter((p) => !cite(p, f)).join(" ");
  for (const f of catalogue()) if (!retenus.some((r) => r.nom === f.nom) && cite(texte, f)) { texte = sans(texte, f); log(`    précédent hors sujet retiré : ${f.nom}`); }
  for (const f of retenus.filter((r) => cite(texte, r))) {
    try {
      const j = await ia("Tu es rédacteur en chef et historien. Réponds en JSON valide.",
        `Dans ce dossier d'actualité, l'auteur compare la situation au précédent « ${f.nom} » (${f.type}).
Le parallèle est-il PERTINENT : EXACTEMENT le même mécanisme (${f.type}), pas un simple point commun de thème, de pays ou de gravité ? Dans le doute : false. Réponds {"pertinent": true|false, "raison": "…"}.

DOSSIER :
${texte}`, { maxTokens: 400, depart: depart + 1, temperature: 0.1, tours: 1 });
      if (j.pertinent === false) { texte = sans(texte, f); log(`    précédent jugé hors sujet, retiré : ${f.nom} (${String(j.raison || "").slice(0, 80)})`); }
    } catch {}
  }
  for (const f of retenus.filter((r) => r.obligatoire && !cite(texte, r))) {
    try {
      const j = await ia(`Tu écris pour un live YouTube d'actualité (« ${ED.chaine} »), ton indigné et direct. Réponds en JSON valide.`,
        `Écris 1 à 2 phrases (35 mots max) qui rappellent ce précédent et posent le parallèle avec le dossier, sous forme de question
ou de rappel (« Souvenez-vous… »), sans aucun fait nouveau sur le dossier, jamais « nous ».
PRÉCÉDENT : ${f.fait}
DOSSIER : ${texte.slice(0, 1500)}
Réponds : {"phrases": "…"}`, { maxTokens: 300, depart, temperature: 0.4, tours: 1 });
      const ajout = LATIN(String(j.phrases || "").trim());
      const st = ajout && cite(ajout, f) ? await verifierPhrases(phrases(ajout), g.texte, depart + 1, victimes) : null;
      const ok = st ? st.sorties.filter(Boolean).join(" ") : "";
      if (ok && cite(ok, f) && !NOUS.test(ok)) {
        const ps = phrases(texte), k = ps.findIndex((p) => SIGN.test(p));
        ps.splice(k >= 0 ? k : Math.max(0, ps.length - 1), 0, ok);
        texte = ps.join(" "); log(`    précédent obligatoire ajouté : ${f.nom}`);
      }
    } catch {}
  }
  return texte;
}

// ---------------------------------------------------------------- 3ter) relecture d'ensemble (comme un rédacteur en chef)
// Lit TOUS les dossiers ensemble : phrase incohérente ou mot qui n'existe pas, humour aux dépens d'une victime, image sexuelle ou
// gore, affirmation non sourcée, contradiction entre deux dossiers. Seules les phrases citées EXACTEMENT sont remplacées (ou
// retirées) ; une correction illisible ou qui ajoute un chiffre absent des sources est ignorée. Jamais bloquant.
async function relire(dossiers, { doublons = true } = {}) {
  if (reste() < 6 * 60e3) return;
  const corps = dossiers.map((d, i) => `### ${i + 1}. ${d.titre}\n${d.texte}`).join("\n\n");
  let j;
  try {
    j = await ia("Tu es rédacteur en chef et juriste d'une émission d'actualité française. Réponds en JSON valide.",
      `Relis ce script de live. Signale UNIQUEMENT les phrases à corriger :
- incohérente, mal construite, ou contenant un mot qui n'existe pas en français ;
- humour ou image aux dépens d'une victime (violences sexuelles, enfants, morts, sinistrés), image sexuelle ou gore ;
${GOLFE ? `- toute attaque, ironie, moquerie ou insinuation visant LA PERSONNE d'un souverain du Golfe (roi, émir, sultan, prince héritier) ou
  de sa famille, l'islam ou un symbole religieux : "remplacement" = la même information dite de façon factuelle, ou "" (critiquer
  les décisions d'un gouvernement, d'une armée ou d'une institution du Golfe, avec attribution, est PERMIS : ne le retire pas) ;
` : ""}- insinuation qu'une personne, la police ou une institution serait l'auteur d'un acte alors que les sources ne le disent pas
  (ex. « la violence vient de l'intérieur du dispositif de sécurité » quand l'auteur du tir n'est pas identifié), ou « coupables »
  pour des personnes non condamnées : "remplacement" = la même question posée sans rien affirmer (« qui a tiré ? l'enquête le dira-t-elle ? »), ou "" ;
- reproche à une institution, à la police ou à la justice NON étayé par un fait du dossier, ou contredit par lui (ex. « inertie » alors que des suspects sont interpellés) : "remplacement" = la même charge reformulée sur le fait établi, ou "" ;
- affirmation présentée comme certaine sans source (au lieu de « selon… », « soupçonné », « présumé ») ;
- contradiction avec un autre dossier du script ;
- le MÊME fait raconté dans deux dossiers différents (ex. la même menace, la même frappe) : garde-le dans le dossier dont c'est le
  sujet, et supprime-le ("remplacement": "") dans l'autre.
Pour chacune : "dossier" (numéro), "phrase" (copiée EXACTEMENT, mot pour mot), "remplacement" (phrase corrigée dans le même style,
sans ajouter aucun fait ni chiffre ; "" pour la supprimer).
Signale aussi les DOSSIERS qui racontent la même histoire (même attaque, même affaire, même loi, même mouvement social ou
même journée de mobilisation, même voyage ou sommet d'un dirigeant) : "doublons" = paires de numéros.
Réponds : {"corrections": [{"dossier": 3, "phrase": "…", "remplacement": "…"}], "doublons": [[1, 10]]} ([] si rien).

${corps}`, { maxTokens: 5000 });
  } catch (e) { log(`  relecture d'ensemble impossible (${e.message}) : script gardé tel quel`); return; }
  let n = 0;
  for (const c of j.corrections || []) {
    const d = dossiers[Number(c.dossier) - 1], ph = String(c.phrase || "").trim(), rp = String(c.remplacement || "").trim();
    if (!d || ph.length < 12 || !d.texte.includes(ph) || /^Précision importante/.test(ph)) continue;
    if (rp && (NOUS.test(rp) || QUEMANDE.test(rp) || HORS_DOSSIER.test(rp) || !chiffres(rp).every((x) => chiffres(d.texte).includes(x)))) continue;
    d.texte = LATIN(d.texte.replace(ph, rp)); n++;
  }
  // doublons repérés : on garde le dossier le plus sourcé (puis le plus long), l'autre est retiré du live
  const retirer = new Set();
  for (const p of doublons ? j.doublons || [] : []) {
    const [a, b] = (Array.isArray(p) ? p : []).map((x) => Number(x) - 1);
    if (!dossiers[a] || !dossiers[b] || a === b || retirer.has(a) || retirer.has(b)) continue;
    const poids = (d) => d.sources.length * 1000 + d.texte.length;
    const perdant = poids(dossiers[a]) >= poids(dossiers[b]) ? b : a;
    const gagnant = perdant === a ? b : a;
    dossiers[gagnant].sources = [...new Map([...dossiers[gagnant].sources, ...dossiers[perdant].sources].map((x) => [x.nom, x])).values()].slice(0, 8);
    retirer.add(perdant);
  }
  for (const i of [...retirer].sort((x, y) => y - x)) { log(`  doublon retiré : ${dossiers[i].titre}`); dossiers.splice(i, 1); }
  log(`  relecture d'ensemble : ${n} phrase(s) corrigée(s)`);
}

// ---------------------------------------------------------------- 4) ordre, ouverture, transitions, clôture
async function habiller(dossiers) {
  // « démarrer fort, finir encore plus fort » : le 2e plus explosif en premier, montée en intensité, la bombe à la fin
  const tri = [...dossiers].sort((a, b) => b.choc - a.choc || b.gravite - a.gravite);
  const ordre = tri.length > 2 ? [tri[1], ...tri.slice(2).reverse(), tri[0]] : tri.reverse();
  let hab = { ouverture: "", transitions: [], cloture: "" };
  try {
    hab = await ia(`Tu écris pour un live YouTube d'actualité choc (« ${ED.chaine} »). Réponds en JSON valide.`,
      `Voici les dossiers du live, dans l'ordre. Écris :
TON : du feu, comme la chaîne — « voilà ce qu'on vous raconte partout, ici on pose les questions que personne ne pose » ; jamais tiède.
- "ouverture" (90 à 150 mots) : hook ultra-choc construit sur le dossier 1, teaser de la bombe finale (dernier dossier) sans la dévoiler,
  puis la phrase d'accueil exacte « ${ED.accueil} », puis une question ouverte au public ;
- "transitions" : pour chaque dossier à partir du 2e, UNE phrase (10 à 25 mots) qui fait le lien avec le précédent et accroche ;
- "cloture" (130 à 200 mots) : la bombe est passée ; synthèse percutante du fil rouge de la soirée ; puis « ${ED.signature.toUpperCase()} », le
  moment fort de la chaîne, UN SEUL pour tout le live : choisis le fait le plus révoltant de la soirée, RAPPELLE-le en une phrase
  (le dossier d'où il vient), explique en deux phrases pourquoi il est inacceptable, puis la phrase qui commence EXACTEMENT par
  « ${GOLFE ? "La position du jour :" : "Le NON du jour : NON à"} » — une charge qui découle de ce qui précède, jamais un slogan de plateau télé, jamais contre une victime
  ni contre une personne non condamnée ; enfin une question ouverte au public et le rendez-vous au prochain live SANS date.
Règles : jamais « nous / notre / nos », jamais « likez / partagez / abonnez-vous », jamais « écrivez X si… », jamais « dans les
commentaires ». Ne parle de ${ED.France} que si un dossier le concerne. Rien d'inventé.${GOLFE ? `
${ED.contexte}` : ""}
Réponds : {"ouverture": "…", "transitions": ["…", …], "cloture": "…"}

Les accroches et transitions ne s'appuient QUE sur les faits ci-dessous (déjà vérifiés) ; aucune exagération (« votre argent est en
danger », « la ligne rouge est franchie ») qui ne figure pas dans ces faits. Français impeccable.

${ordre.map((d, i) => `${i + 1}. [${d.categorie}] ${d.titre} — ${phrases(d.texte).slice(0, 3).join(" ")}`).join("\n")}`, { maxTokens: 3000 });
  } catch (e) { log(`  ouverture/transitions impossibles (${e.message}) : repli sobre`); }
  const propre = (s, accueil = false) => String(s || "").split(/(?<=[.!?…])\s+/)
    .filter((p) => !NOUS.test(p) && !QUEMANDE.test(p) && !/dans les commentaires|en commentaire/i.test(p) && (accueil || !/\bbienvenue\b/i.test(p))).map(LATIN).filter(Boolean);
  const parts = [propre(hab.ouverture, true), ...ordre.map((_, i) => (i ? propre((hab.transitions || [])[i - 1]) : [])), propre(hab.cloture)];
  // L'HABILLAGE AUSSI EST VÉRIFIÉ : une accroche ou une transition qui affirme un fait (« votre argent est en danger », « l'OTAN
  // forcée à répondre ») doit être prouvée par les dossiers déjà vérifiés ; sinon elle est retirée. La phrase d'accueil est gardée.
  const ACCUEIL = new RegExp(`^${ED.accueil.split(/[,.]/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const aVerif = [];
  parts.forEach((ps, k) => ps.forEach((p, m) => { if (!ACCUEIL.test(p)) aVerif.push([k, m, p]); }));
  const base = ordre.map((d, i) => `### ${i + 1}. ${d.titre}\n${d.faits.join(". ")}\n${d.texte}`).join("\n\n");
  const st = aVerif.length ? await verifierPhrases(aVerif.map((x) => x[2]), base, 1, ordre.some((d) => d._victimes)) : { sorties: [] };
  if (st) aVerif.forEach(([k, m], i) => { parts[k][m] = st.sorties[i]; });
  else aVerif.forEach(([k, m, p]) => { if (!/\?\s*$/.test(p)) parts[k][m] = null; });      // vérification impossible : seules les questions restent
  if (st?.retirees) log(`  habillage : ${st.retirees} phrase(s) d'accroche ou de transition retirée(s) (fait non prouvé)`);
  const recoller = (ps) => ps.filter(Boolean).join(" ").trim();
  let ouverture = recoller(parts[0]);
  if (!ACCUEIL.test(ouverture) && !ouverture.includes(ED.accueil.split(/[,.]/)[0])) ouverture = `${ouverture} ${ED.accueil}`.trim();
  return {
    ordre,
    // ouverture amputée par la vérification : reconstruite sur les titres vérifiés (le 1er dossier, puis l'annonce de la fin)
    ouverture: ouverture.split(/\s+/).length >= 40 ? ouverture
      : `Au programme ce soir : ${ordre.slice(0, 4).map((d) => d.titre.replace(/[.…]+$/, "")).join(" ; ")}. Et un dernier dossier, gardé pour la fin. ${ouverture}`.replace(/\s{2,}/g, " ").trim(),
    transitions: ordre.map((_, i) => (i ? recoller(parts[1 + i]) : "")),
    cloture: recoller(parts[parts.length - 1]) || "Voilà pour ce tour de la War Room. Et vous, quel dossier vous inquiète le plus ce soir ?",
  };
}

// ---------------------------------------------------------------- 5) titre, description et tags YouTube
// Titre COURT et CHOC (≤ 70 caractères), bâti uniquement sur les dossiers vérifiés ; description avec le programme, la mention des
// sources et de la présomption d'innocence, une question ouverte, puis les tags (dans la description ET à part) et les hashtags.
async function youtube(ordre) {
  const liste = ordre.map((d) => d.titre);
  const ref = ordre.map((d) => `${d.titre} ${d.texte || ""}`).join(" ");
  let j = {};
  try {
    j = await ia(`Tu es responsable YouTube d'une chaîne d'actualité ${GOLFE ? "du Golfe" : "française"} indépendante (« ${ED.chaine} »). Réponds en JSON valide.`,
      `Voici les dossiers du live de ce soir (dans l'ordre ; le DERNIER est la surprise de fin, ne le dévoile pas dans le titre).
Écris :
- "titres" : 3 titres YouTube COURTS (35 à 60 caractères), PROVOCANTS, dans le ton de la chaîne (indignation, question qui dérange,
  contraste, mystère) — jamais un titre plat de type « le point », « l'actu », « les faits marquants ». Exemples de TON (pas de contenu) :
  « On vous ment encore sur l'Iran ? », « Ce que le 20h ne vous dira pas », « Ils ont voté ça pendant que vous dormiez ».
  Seulement des faits présents dans la liste ; aucune accusation contre une personne présentée comme prouvée ; pas d'émoji ;
- "accroche" : 2 phrases d'ouverture de description, percutantes, sans « nous » ni « on » ;
- "question" : une question ouverte au public (jamais « écrivez X si… ») ;
- "tags" : 25 à 35 tags (personnes, lieux, affaires, thèmes) tirés des dossiers.
Réponds : {"titres": ["…","…","…"], "accroche": "…", "question": "…", "tags": ["…"]}

${liste.map((x, i) => `${i + 1}. ${x}`).join("\n")}`, { maxTokens: 2000, temperature: 0.7 });
  } catch (e) { log(`  titre YouTube : IA indisponible (${String(e.message).slice(0, 80)}) → titre de secours`); }
  const ok = (s) => s && !NOUS.test(s) && !QUEMANDE.test(s) && nomsConnus(s, ref) && chiffresSurs(s, ref);
  const titres = (j.titres || []).map((x) => LATIN(String(x)).trim()).filter((x) => x.length >= 20 && x.length <= 80 && ok(x));
  const secours = `${liste[0]} : ${liste.length} dossiers décryptés`.slice(0, 90);
  const tags = [...new Set([...(j.tags || []).map((x) => LATIN(String(x)).replace(/[#,]/g, "").trim()).filter((x) => x && x.length <= 40),
    ...(GOLFE ? ["Golfe", "Arabie saoudite", "Émirats", "Qatar", "Koweït", "Oman", "Bahreïn", "analyse géopolitique", "Gulf Think-Tank"]
      : ["actualité", "actu France", "décryptage", "analyse indépendante", "Le Journal du NON"])])].slice(0, 40);
  const hashtags = GOLFE ? ["#الخليج", "#السعودية", "#الإمارات", "#قطر", "#تحليل", "#GulfThinkTank"] : ["#Actualité", "#France", "#Décryptage", "#LeJournalDuNON"];
  const acc = ok(j.accroche) ? LATIN(j.accroche) : `${liste.length} dossiers. Des faits sourcés, des avis assumés : à vous de juger.`;
  const q = ok(j.question) && /\?\s*$/.test(j.question) ? LATIN(j.question) : "Et vous, quel dossier de cette semaine vous a le plus marqué ?";
  const desc = [acc, "", "Au programme :", ...liste.slice(0, -1).map((x) => `▶ ${x}`), "… et un dernier dossier, gardé pour la fin.", "",
    "Toutes les sources sont citées à l'antenne. Les personnes mises en cause sont présumées innocentes tant qu'elles n'ont pas été condamnées.",
    "", q, "", `Tags : ${tags.join(", ")}`, "", hashtags.join(" ")].join("\n");
  return [`TITRE (choisis-en un) :`, ...(titres.length ? titres : [secours]).map((x) => `- ${x}`), "", "DESCRIPTION :", desc, "",
    "TAGS (à coller dans le champ Tags de YouTube Studio) :", tags.join(", "), ""].join("\n");
}

// GOLFE : juge final de chaque dossier écrit (texte français vérifié). Tout est permis — mauvaises nouvelles, critique des décisions
// des gouvernements, armées et institutions du Golfe, rumeurs attribuées (« selon X », « une seule source affirme ») — SAUF attaquer la
// personne d'un souverain (roi, émir, sultan, prince héritier) ou de sa famille, ou l'islam. IA indisponible → dossier écarté (prudence).
async function tabouGolfe(d) {
  try {
    const j = await ia(`Tu es le rédacteur en chef de « Gulf Think-Tank », chaîne d'analyse pour le public des pays du Golfe (Arabie saoudite, Émirats, Qatar, Koweït, Oman, Bahreïn). Réponds en JSON valide.`,
      `Ce texte peut-il passer à l'antenne ?
PERMIS : les mauvaises nouvelles qui touchent un pays du Golfe ; la critique des DÉCISIONS, politiques et opérations des gouvernements,
ministères, armées et institutions du Golfe ; les rumeurs et accusations ATTRIBUÉES (« selon X », « une seule source affirme ») ; critiquer
l'Iran, Israël, les milices, les puissances occidentales, les médias.
INTERDIT seulement : attaquer, moquer, insulter ou insinuer contre LA PERSONNE d'un souverain du Golfe (roi, émir, sultan, prince
héritier) ou de sa famille ; attaquer l'islam ou un symbole religieux ; une accusation grave NON attribuée présentée comme un fait.
Réponds : {"interdit": true|false, "raison": "…"}

TITRE : ${d.titre}
TEXTE : ${d.texte}`, { maxTokens: 600, temperature: 0 });
    return j.interdit === true ? `attaque d'un souverain, de sa famille ou de l'islam (${String(j.raison || "").slice(0, 100)})` : "";
  } catch (e) { return `contrôle Golfe impossible (${String(e.message).slice(0, 60)})`; }
}

// ---------------------------------------------------------------- 6) ÉDITION GOLFE : traduction en ARABE STANDARD (fusha)
// Le script est écrit et vérifié en français (garde-fous juridiques rodés), puis traduit. Contrôles : chaque nombre du français se
// retrouve dans l'arabe (chiffres occidentaux), aucun reste en lettres latines (sauf sigles et « Gulf Think-Tank »). Un texte qui
// échoue est retraduit seul, plus strictement ; s'il échoue encore, il est gardé et signalé dans le journal.
const ARABE_SYS = `Tu es le traducteur et rédacteur en chef arabe de la chaîne « Gulf Think-Tank » (public des pays du Golfe). Tu traduis
en ARABE STANDARD MODERNE (فصحى) de grande chaîne d'information, phrases courtes, rythme oral, ton percutant ; tu gardes l'ironie mordante
et l'humour noir là où ils sont, et EXACTEMENT les faits, noms, dates et attributions (« selon… », conditionnel = صيغة الاحتمال/« بحسب »).
Les noms propres sont écrits en arabe (translittération usuelle). Tous les nombres en CHIFFRES OCCIDENTAUX (0-9). Aucun mot en lettres
latines, sauf « Gulf Think-Tank » et les sigles (OTAN → الناتو de préférence). « La position du jour » se traduit EXACTEMENT « خلاصة القول اليوم », et SEULEMENT là où « La position du jour » figure : n'emploie JAMAIS
« خلاصة القول اليوم » pour autre chose (« Précision importante » = « توضيح هام »). Traduis TOUT le texte, sans rien résumer ni couper. Réponds en JSON valide.`;
const nombresDe = (t) => chiffres(t).filter((n) => n.length >= 2);
const versOccidental = (t) => String(t).replace(/[٠-٩]/g, (c) => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/[۰-۹]/g, (c) => "۰۱۲۳۴۵۶۷۸۹".indexOf(c));
const LATIN_RESTE = (t) => (String(t).replace(/Gulf Think-Tank|#\S+/g, "").match(/\b[A-Za-zÀ-ÿ]{3,}\b/g) || []).filter((w) => w !== w.toUpperCase());
function arabeOk(fr, ar) {
  if (!ar || !/[\u0600-\u06FF]/.test(ar)) return false;
  const nAr = new Set(chiffres(versOccidental(ar)));
  const mFr = String(fr).split(/\s+/).filter(Boolean).length, mAr = String(ar).split(/\s+/).filter(Boolean).length;
  if (mFr >= 25 && mAr < 0.55 * mFr) return false;            // traduction tronquée ou résumée
  return nombresDe(fr).every((n) => nAr.has(n) || /^(19|20)\d\d$/.test(n) && nAr.has(n)) && LATIN_RESTE(ar).length <= 1;
}
async function traduireAr(textes) {
  const out = new Array(textes.length).fill("");
  const lots = [];
  let cur = [], taille = 0;
  textes.forEach((t, i) => { const n = String(t || "").length; if (cur.length && (taille + n > 6000 || cur.length >= 8)) { lots.push(cur); cur = []; taille = 0; } cur.push(i); taille += n; });
  if (cur.length) lots.push(cur);
  for (const lot of lots) {
    const vides = lot.filter((i) => !String(textes[i] || "").trim());
    const a = lot.filter((i) => !vides.includes(i));
    if (!a.length) continue;
    try {
      const j = await ia(ARABE_SYS, `Traduis chaque texte. Réponds : {"ar": ["…", …]} (même nombre, même ordre).\n\n${a.map((i, k) => `[${k + 1}] ${textes[i]}`).join("\n\n")}`,
        { maxTokens: 8000, temperature: 0.3, depart: 0 });
      (j.ar || []).forEach((x, k) => { if (a[k] !== undefined) out[a[k]] = String(x || "").trim(); });
    } catch (e) { log(`  traduction arabe : lot impossible (${String(e.message).slice(0, 80)}) → texte par texte`); }
  }
  for (let i = 0; i < textes.length; i++) {
    if (!String(textes[i] || "").trim() || arabeOk(textes[i], out[i])) continue;
    try {
      const j = await ia(ARABE_SYS, `Traduis ce texte. ATTENTION : chaque nombre doit apparaître en chiffres occidentaux (${nombresDe(textes[i]).join(", ") || "aucun"}) et aucun mot latin ne doit rester.
Réponds : {"ar": "…"}\n\n${textes[i]}`, { maxTokens: 6000, temperature: 0.2, depart: 1 });
      const ar = String(j.ar || "").trim();
      if (arabeOk(textes[i], ar) || !out[i]) out[i] = ar || out[i];
    } catch {}
    if (!arabeOk(textes[i], out[i])) log(`  ⚠ traduction arabe à relire (texte ${i + 1} : nombres, mots latins ou longueur) : « ${String(textes[i]).slice(0, 60)}… »`);
  }
  return out.map((x, i) => x || String(textes[i] || ""));
}
// relecture ORTHOGRAPHIQUE de l'arabe des dossiers (fautes des modèles de secours : « نفت » pour « نفط »…). Acceptée seulement si
// le sens reste identique au contrôle (mêmes nombres que le français, pas de latin) et la longueur à ±15 % ; sinon l'original reste.
async function relireAr(ordre) {
  if (reste() < 6 * 60e3) { log("  relecture arabe : pas le temps → texte gardé tel quel"); return; }
  let n = 0;
  for (const d of ordre) {
    if (reste() < 4 * 60e3) break;
    try {
      const j = await ia(ARABE_SYS, `Corrige SEULEMENT l'orthographe, la grammaire et les mots tronqués de ce texte arabe (ex. « نفت » → « نفط »). Ne change ni le sens,
ni l'ordre, ni les noms, ni les nombres ; ne résume rien, n'ajoute rien. Une phrase incomplète (un nom seul, sans verbe) est supprimée.
Corrige aussi le TITRE de la même façon.
Réponds : {"titre": "…", "ar": "…"}\n\nTITRE : ${d.titre}\n\nTEXTE : ${d.texte}`, { maxTokens: 6000, temperature: 0.1 });
      const ar = String(j.ar || "").trim(), m0 = d.texte.split(/\s+/).length, m1 = ar.split(/\s+/).length;
      if (ar && m1 >= 0.85 * m0 && m1 <= 1.15 * m0 && arabeOk(d.texte_fr || "", ar)) { if (ar !== d.texte) n++; d.texte = ar; }
      const ti = String(j.titre || "").trim();
      if (/[\u0600-\u06FF]/.test(ti) && !LATIN_RESTE(ti).length && ti.length <= 1.5 * d.titre.length + 5) d.titre = ti;
    } catch {}
  }
  log(`  relecture arabe : ${n} dossier(s) corrigé(s)`);
}
function youtubeSecoursAr(ordre) {
  const t = ordre.map((d) => String(d.titre || "").replace(/[«»]/g, "").trim()).filter((x) => /[\u0600-\u06FF]/.test(x));
  const tags = [...new Set([...t.filter((x) => !/[,،:]/.test(x) && x.length <= 30),
    ...ordre.flatMap((d) => String(d.lieu || "").split(/[,،]/)).map((x) => x.trim()).filter((x) => /[\u0600-\u06FF]/.test(x)),
    "الخليج", "السعودية", "الإمارات", "قطر", "الكويت", "عُمان", "البحرين", "تحليل جيوسياسي", "Gulf Think-Tank"])].slice(0, 40);
  const desc = [`${ordre.length} ملفات الليلة. وقائع موثّقة وآراء صريحة: والحكم لكم.`, "", "البرنامج:", ...t.slice(0, -1).map((x) => `▶ ${x}`),
    "… وملف أخير محفوظ للنهاية.", "", "جميع المصادر مذكورة على الهواء. كل شخص متهم بريء حتى تثبت إدانته.", "",
    "برأيكم، أي ملف من ملفات الليلة يطرح السؤال الأخطر؟", "", `الوسوم: ${tags.join("، ")}`, "", "#الخليج #السعودية #الإمارات #قطر #تحليل #GulfThinkTank"];
  return ["العنوان (اختر واحداً):", ...t.slice(0, 2).map((x) => `- ${x}… والسؤال الذي لا يطرحه أحد`), "", "الوصف:", ...desc, "",
    "الوسوم (للصق في خانة Tags في YouTube Studio):", tags.join(", "), ""].join("\n");
}
const CAT_AR = { CATASTROPHE: "كارثة", ACCIDENT: "حادث", SCANDALE: "فضيحة", CORRUPTION: "فساد", POLITIQUE: "سياسة", "GÉOPOLITIQUE": "جيوسياسة",
  GUERRE: "حرب", "RÉVÉLATION": "كشف", CYBER: "سيبراني", "FAIT DIVERS": "حوادث", INSOLITE: "غرائب", RUMEUR: "شائعة" };

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const duree = (t) => (String(t).split(/\s+/).filter(Boolean).length / WPM) * 60;

// ---------------------------------------------------------------- SUJETS IMPOSÉS (champ « sujets » du workflow, vide par défaut)
// Un sujet que tu veux absolument dans le live (ex. « Trump piratage FBI ») : cherché dans tout ce qui a été collecté ET en direct
// (GDELT, 48 h), puis ajouté en tête du live sans passer par le filtre de choc. Rien trouvé = dit clairement dans le journal.
async function sujetsImposes(items) {
  const liste = String(process.env.WARROOM_SUJETS || "").split(/[\n;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
  const out = [];
  for (const [i, q] of liste.entries()) {
    const m = [...new Set(mots(q))];
    if (!m.length) continue;
    const need = Math.max(1, Math.ceil(m.length * 0.67));
    const hit = (x) => { const t = new Set(mots(`${x.titre} ${x.resume || ""}`)); return m.filter((w) => t.has(w)).length >= need; };
    const trouves = items.filter(hit);
    try {
      const r = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(m.join(" "))}&mode=artlist&maxrecords=25&timespan=48h&format=json`, { signal: AbortSignal.timeout(30000) });
      const j = r.ok ? await r.json() : null;
      for (const a of j?.articles || []) if (a.url && !trouves.some((x) => x.url === a.url)) trouves.push({ titre: deshtml(a.title || ""), url: a.url, source: a.domain, date: new Date().toISOString(), origine: "gdelt" });
    } catch {}
    await dormir(5.5);
    if (!trouves.length) { console.log(`::warning::sujet imposé « ${q} » : aucun article trouvé dans les 48 dernières heures`); continue; }
    const g = { id: 9000 + i, items: trouves.slice(0, 12), mots: new Set(m), impose: true, officiel: false, revendication: false };
    g.nb_sources = new Set(g.items.map((x) => (x.source || "").toLowerCase().replace(/^www\./, "")).filter(Boolean)).size;
    let n = {};
    try { n = await ia("Tu es rédacteur en chef. Réponds en JSON valide.", `Sujet demandé : « ${q} ». Articles :\n${g.items.slice(0, 6).map((x) => `• ${x.titre}`).join("\n")}\nRéponds : {"categorie": "CATASTROPHE|ACCIDENT|SCANDALE|CORRUPTION|POLITIQUE|GÉOPOLITIQUE|GUERRE|RÉVÉLATION|CYBER|FAIT DIVERS|INSOLITE|RUMEUR", "evenement": "3 à 8 mots", "pays": "pays principal", "ville": ""}`, { maxTokens: 300, temperature: 0.1, tours: 2 }); } catch {}
    g.note = { choc: 10, interet_fr: 10, actuel: true, categorie: n.categorie || "POLITIQUE", evenement: n.evenement || q, pays: n.pays || "", ville: n.ville || "" };
    log(`  sujet imposé « ${q} » : ${g.items.length} article(s), ${g.nb_sources} source(s), catégorie ${g.note.categorie}`);
    out.push(g);
  }
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { items, etat, contre } = existsSync(process.env.WARROOM_BRUT || "") ? { items: JSON.parse(readFileSync(process.env.WARROOM_BRUT, "utf8")), etat: {}, contre: existsSync(`${OUT}/autres.json`) ? JSON.parse(readFileSync(`${OUT}/autres.json`, "utf8")) : [] } : await collecter();
  POOL_AUTRES = contre || [];
  const groupes = regrouper(items);
  log(`${groupes.length} événements distincts`);
  const notes = await trier(groupes);
  // les articles « fourre-tout » (« Ce qu'il faut retenir », « L'essentiel », « En direct »…) ne font pas un sujet
  const FOURRE_TOUT = /ce qu.il faut (savoir|retenir)|l.essentiel de l.actu|les infos? (du jour|à retenir)|^\s*(en )?direct\b|le point sur l.actu|what we know|live updates|news (wrap|roundup)/i;
  // une info d'UNE SEULE source n'est pas supprimée si elle est vraiment chaude (choc ≥ 8) : elle passe, annoncée comme telle
  // (« seule X le rapporte »), au conditionnel, avec le tampon « SOURCE UNIQUE · NON CONFIRMÉ » à l'écran
  const chaudeUnique = (g) => g.nb_sources === 1 && Number(g.note?.choc) >= Number(process.env.WARROOM_SEUIL_UNIQUE || 8);
  const solides = notes.filter((g) => !(GOLFE && g.note?.tabou_golfe === true) && (g.nb_sources >= 2 || g.officiel || g.revendication || chaudeUnique(g)) && !FOURRE_TOUT.test(g.items[0]?.titre || ""));
  if (solides.some(chaudeUnique)) log(`  ${solides.filter(chaudeUnique).length} info(s) très chaude(s) d'une seule source gardée(s), annoncée(s) comme non confirmée(s)`);
  // AUDIENCE FRANÇAISE : la France d'abord ; l'international seulement s'il mérite vraiment l'attention des Français (≥ 7/10),
  // et jamais plus de 40 % des dossiers
  const enFrance = (g) => ED.paysPublic.test(String(g.note.pays || "").trim());      // « chez le public » (France ou Golfe)
  const interet = (g) => (enFrance(g) ? 10 : Number(g.note.interet_fr) || 0);
  const score = (g) => Number(g.note.choc) + 0.6 * interet(g) + (g.officiel ? 0.5 : 0) + Math.min(1.5, g.nb_sources * 0.25);
  const candidats = solides.filter((g) => g.note.actuel !== false && Number(g.note.choc) >= Number(process.env.WARROOM_SEUIL || 6) && interet(g) >= 7)
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_DOSSIERS + 25);
  const imposes = await sujetsImposes(items);
  const memeSujet = (a, b) => { const u = new Set(a.items.map((x) => x.url).filter(Boolean)); if (b.items.some((x) => u.has(x.url))) return true;
    const ma = new Set(mots(a.note.evenement || a.items[0].titre)), mb = new Set(mots(b.note.evenement || b.items[0].titre)); let k = 0; for (const w of ma) if (mb.has(w)) k++; return k / Math.max(3, Math.min(ma.size, mb.size)) >= 0.6; };
  const uniques = [...imposes, ...(await fusionner(candidats)).filter((g) => !imposes.some((i) => memeSujet(i, g)))];
  const maxMonde = Math.max(2, Math.floor((MAX_DOSSIERS + 6) * 0.4));
  let nMonde = 0;
  const retenus = uniques.filter((g) => g.impose || enFrance(g) || nMonde++ < maxMonde).slice(0, MAX_DOSSIERS + 6);   // quelques réserves si un dossier ne tient pas
  log(`  ${retenus.filter(enFrance).length} sujets France, ${retenus.filter((g) => !enFrance(g)).length} internationaux qui concernent la France`);
  log(`${solides.length} sujets solides (≥ 2 sources ou source officielle), ${retenus.length} assez choc retenus`);
  // ÉCRITURE EN PARALLÈLE : WARROOM_VOIES dossiers à la fois (3 par défaut), répartis entre fournisseurs (Gemini / Groq) ;
  // un modèle saturé est mis en pause pour toutes les voies, qui passent alors au modèle suivant. L'ordre des dossiers est conservé.
  const VOIES = Math.max(1, Number(process.env.WARROOM_VOIES || 3));
  const ecrits = new Map();
  let suivant = 0, ok = 0, nUnique = 0;
  // plafond facultatif de dossiers d'une seule source (WARROOM_MAX_UNIQUE) ; par défaut aucun, comme l'édition française
  const MAX_UNIQUE = Number(process.env.WARROOM_MAX_UNIQUE || 1e9);
  async function voie(v) {
    while (suivant < retenus.length && ok < MAX_DOSSIERS && reste() > (GOLFE ? 20 : 8) * 60e3) {   // Golfe : 20 min gardées pour habillage + traduction + YouTube
      const i = suivant++, g = retenus[i];
      await enrichir(g);
      if (sujetAutolyse(g)) { log(`  ✗ ${g.items[0].titre.slice(0, 80)} : suicide ou automutilation → jamais dans le live`); continue; }
      if (g.nb_sources === 1 && !g.officiel && nUnique >= MAX_UNIQUE) { log(`  ✗ ${g.items[0].titre.slice(0, 80)} : déjà ${MAX_UNIQUE} dossiers d'une seule source → réserve suivante`); continue; }
      try {
        const d = await ecrireDossier(g, i, v);
        if (GOLFE) { const tb = await tabouGolfe(d); if (tb) { log(`  ✗ ${d.titre} : ${tb} → écarté (jamais contre le Golfe)`); continue; } }
        if (ok >= MAX_DOSSIERS) break;
        if (d.unique) nUnique++;
        ok++; ecrits.set(i, d); log(`  ✓ [${d.categorie}] ${d.titre} (${d.texte.split(/\s+/).length} mots, ${g.nb_sources} sources)`);
      } catch (e) { log(`  ✗ ${g.items[0].titre.slice(0, 80)} : ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: VOIES }, (_, v) => voie(v)));
  let dossiers = [...ecrits.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d);
  // vérification des faits manquée (IA saturée) : nouvel essai, un par un ; toujours impossible → dossier retiré (jamais de texte non vérifié)
  for (const d of dossiers.filter((x) => x.aVerifier)) {
    const v = await verifierFaits(d.texte, d._src, 0, d._victimes);
    if (!v.ok) log(`  ✗ ${d.titre} : faits non vérifiables (IA indisponible) → dossier retiré`);
    else if (maigre(v)) log(`  ✗ ${d.titre} : trop peu de faits prouvés → dossier retiré`);
    else { d.texte = d._seule ? `Précision importante : cette information n'est rapportée que par ${listeNoms(d._seule)}, aucune autre rédaction ne la confirme à ce stade. ${v.texte}` : v.texte; d.aVerifier = false; }
  }
  dossiers = dossiers.filter((d) => !d.aVerifier && d.texte.split(/\s+/).length >= 100);
  if (!dossiers.length) throw new Error("aucun dossier assez solide aujourd'hui (sources ou IA indisponibles) : relance plus tard");
  await relire(dossiers);
  const hab = await habiller(dossiers);
  // relecture de la langue de l'habillage (ouverture, transitions, clôture) : mêmes règles, sans recherche de doublons
  const pseudo = [{ titre: "OUVERTURE", texte: hab.ouverture, sources: [] }, ...hab.transitions.map((x, i) => ({ titre: `TRANSITION ${i}`, texte: x, sources: [] })), { titre: "CLÔTURE", texte: hab.cloture, sources: [] }];
  await relire(pseudo.filter((x) => x.texte), { doublons: false });
  hab.ouverture = pseudo[0].texte; hab.transitions = pseudo.slice(1, -1).map((x) => x.texte); hab.cloture = pseudo[pseudo.length - 1].texte;
  // un seul « Le NON du jour » (le premier) : un second est retiré avec la phrase qui le porte
  { let vu = false; hab.cloture = phrases(hab.cloture || "").filter((p) => { if (!SIGN.test(p)) return true; if (vu) return false; vu = true; return true; }).join(" "); }
  // la relecture peut avoir vidé ou raccourci l'ouverture / la clôture : jamais de partie vide au prompteur
  if (!hab.ouverture.includes(ED.accueil.split(/[,.]/)[0])) hab.ouverture = `${hab.ouverture} ${ED.accueil}`.trim();
  if (hab.ouverture.split(/\s+/).length < 40) hab.ouverture = `Au programme ce soir : ${hab.ordre.slice(0, 4).map((d) => d.titre.replace(/[.…]+$/, "")).join(" ; ")}. Et un dernier dossier, gardé pour la fin. ${hab.ouverture}`.replace(/\s{2,}/g, " ").trim();
  if (String(hab.cloture || "").split(/\s+/).filter(Boolean).length < 12) hab.cloture = `${hab.cloture || ""} Voilà pour ce tour de la War Room. Les faits sont sourcés, les avis sont assumés : à vous de juger. Et vous, quel dossier de ce soir vous a le plus révolté ? À très vite pour le prochain live.`.replace(/\s{2,}/g, " ").trim();
  // la vérification (IA surchargée) peut avoir retiré la phrase signature : jamais de clôture sans elle
  if (!phrases(hab.cloture || "").some((p) => SIGN.test(p))) {
    const bombe = String(hab.ordre[hab.ordre.length - 1]?.titre || "").replace(/[.…]+$/, "");
    const sig = GOLFE ? `La position du jour : sur « ${bombe} », les faits sont sourcés, les versions officielles se contredisent, et le public a droit à la vérité entière, pas à un communiqué.`
      : `Le NON du jour : NON à l'opacité sur « ${bombe} » : les faits sont sourcés, les versions officielles se contredisent, et vous avez droit à la vérité entière.`;
    const ps = phrases(hab.cloture || ""), q = ps.length && /\?\s*$/.test(ps[ps.length - 1]) ? ps.pop() : "";
    hab.cloture = [...ps, sig, q].filter(Boolean).join(" ");
    log(`  clôture : « ${ED.signature} » retirée par la vérification → phrase de repli sur le dernier dossier`);
  }
  if (GOLFE) {
    log("Traduction en arabe standard (fusha)…");
    const T = [hab.ouverture, hab.cloture, ...hab.transitions, ...hab.ordre.flatMap((d) => [d.texte, d.titre, d.lieu || "", d.chiffre?.libelle || "", ...(d.faits || [])])];
    const A = await traduireAr(T);
    let k = 0;
    const SIG_AR = /\s*خلاصة القول اليوم\s*[:：،,]?\s*/g;
    const sansSig = (x) => String(x || "").replace(SIG_AR, " ").replace(/\s{2,}/g, " ").trim();
    hab.ouverture = sansSig(A[k++]); hab.cloture = A[k++]; hab.transitions = hab.transitions.map(() => sansSig(A[k++]));
    if (!/خلاصة القول اليوم/.test(hab.cloture || "")) log("  ⚠ clôture : « خلاصة القول اليوم » absent de la traduction (à dire à l'antenne)");
    const finSig = (hab.cloture || "").search(/خلاصة القول اليوم/);
    if (finSig >= 0) hab.cloture = hab.cloture.slice(0, finSig) + "خلاصة القول اليوم:" + sansSig(hab.cloture.slice(finSig)).replace(/^/, " ");
    for (const d of hab.ordre) {
      d.texte_fr = d.texte; d.texte = sansSig(A[k++]); d.titre_fr = d.titre; d.titre = A[k++]; d.lieu = A[k++] || d.lieu;
      const lib = A[k++]; if (d.chiffre) d.chiffre = { ...d.chiffre, libelle: lib || d.chiffre.libelle };
      d.faits = (d.faits || []).map(() => A[k++]);
      d.categorie_ar = CAT_AR[d.categorie] || d.categorie;
    }
    await relireAr(hab.ordre);
  }
  const { ordre, ouverture, transitions, cloture } = hab;
  // minutage (débit de lecture) + prompteur avec repères
  let t = 0;
  const P = [`WAR ROOM${GOLFE ? " GOLFE" : ""} — ${new Date().toLocaleDateString(GOLFE ? "ar" : "fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`, "", "▶ OUVERTURE", "", ouverture, ""];
  const segs = [{ type: "ouverture", t0: 0, t1: (t += duree(ouverture)) }];
  ordre.forEach((d, i) => {
    const tx = [transitions[i], d.texte].filter(Boolean).join(" ");
    const t0 = t; t += duree(tx);
    segs.push({ type: "dossier", n: i + 1, t0, t1: t, ...d, texte: undefined, _src: undefined, _victimes: undefined, _seule: undefined, aVerifier: undefined });
    P.push(`▶ DOSSIER ${i + 1}/${ordre.length} · ${GOLFE ? d.categorie_ar : d.categorie} · ${mmss(t0)}`, GOLFE ? `« ${d.titre} »` : `« ${d.titre} »`, "", tx, "");
  });
  segs.push({ type: "cloture", t0: t, t1: (t += duree(cloture)) });
  P.push(`▶ CLÔTURE · ${mmss(segs[segs.length - 1].t0)}`, "", cloture, "");
  const spec = { version: 1, lang: GOLFE ? "ar" : "fr", edition: GOLFE ? "golfe" : "france", date: new Date().toISOString(), wpm: WPM, duree: t, segments: segs, ticker: ordre.map((d) => d.titre) };
  writeFileSync(`${OUT}/prompteur.txt`, P.join("\n"));
  { let yt = await youtube(GOLFE ? ordre.map((d) => ({ ...d, titre: d.titre_fr || d.titre, texte: d.texte_fr || d.texte })) : ordre);
    if (GOLFE) {   // ligne par ligne : un seul gros texte revenait réduit au titre
      const L = yt.split("\n");
      const idx = L.map((x, i) => (x.trim() && !/^#/.test(x.trim()) ? i : -1)).filter((i) => i >= 0);
      const tr = await traduireAr(idx.map((i) => L[i]));
      idx.forEach((i, k) => { L[i] = tr[k] || L[i]; });
      yt = L.join("\n");
      // une ligne restée en français (IA épuisée) : jamais de youtube.txt à moitié français → version arabe de secours
      if (idx.some((i) => !/[\u0600-\u06FF]/.test(L[i]) && LATIN_RESTE(L[i]).length > 1)) {
        log("  ⚠ youtube.txt : traduction incomplète → version arabe de secours (titres arabes des dossiers)");
        yt = youtubeSecoursAr(ordre);
      }
    }
    writeFileSync(`${OUT}/youtube.txt`, yt); }
  writeFileSync(`${OUT}/warroom.json`, JSON.stringify(spec, null, 1));
  writeFileSync(`${OUT}/sources.md`, ["# Sources — War Room du jour", "", ...ordre.flatMap((d, i) => [`## ${i + 1}. ${d.titre}`, ...d.sources.map((s) => `- ${s.nom}${s.url ? ` — ${s.url}` : ""}`), ""])].join("\n"));
  log(`\nWar Room prête : ${ordre.length} dossiers, ≈ ${Math.round(t / 60)} min de lecture (${WPM} mots/min). Sources : ${JSON.stringify(etat)}`);
}

if (process.argv[1] && process.argv[1].endsWith("ecrire.mjs")) await main().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
