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
      const j = await ia("Tu es rédacteur en chef d'une émission d'actualité choc pour un public FRANÇAIS. Réponds en JSON valide.",
        `Pour chaque sujet ci-dessous (actualité des dernières 24 h), donne :
- "choc" : 0 à 10 = à quel point il CHOQUE, INDIGNE ou INQUIÈTE le grand public (catastrophe, morts, scandale, corruption, accident grave,
  guerre, escalade, fuite, révélation, piratage, fait divers grave, insolite et grave, rumeur/complot qui fait le buzz). 0 = banal, sport,
  people sans gravité, promotion, publicité, météo ordinaire, bourse ordinaire.
- "categorie" : CATASTROPHE, ACCIDENT, SCANDALE, CORRUPTION, POLITIQUE, GÉOPOLITIQUE, GUERRE, RÉVÉLATION, CYBER, FAIT DIVERS, INSOLITE ou RUMEUR.
  Échelle MONDIALE : un accident ou un fait divers local avec une seule victime vaut 4 au plus (sauf circonstances inouïes) ;
  une guerre qui s'étend, une catastrophe meurtrière, un scandale d'État, une fuite massive valent 8 à 10.
- "interet_fr" : 0 à 10 = à quel point un Français moyen s'y intéresse et en parlerait. Tout ce qui se passe EN FRANCE ou touche
  directement les Français (victimes françaises, argent, prix, énergie, sécurité, Europe, guerre aux portes de l'Europe, grandes
  puissances, menace mondiale, buzz mondial) = 7 à 10. Un événement lointain sans lien avec la France (petit pays, politique locale
  étrangère, fait divers à l'étranger) = 0 à 3, même s'il est grave, SAUF s'il est d'une ampleur exceptionnelle.
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

// étiquettes de plan que certains modèles écrivent dans le texte (« Mini-hook : », « Punchline : », « Question ouverte : »…) : retirées
const ETIQ = /(^|[.!?…]\s+)(?:mini[\s‑-]?hook|hook|accroche|punchline|chute|question ouverte|question au public|d[ée]cryptage|analyse|angle|les faits|faits|conclusion)\s*:\s*/gi;
const sansEtiquettes = (t) => String(t).replace(ETIQ, "$1").replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (m, a, c) => a + c.toUpperCase());

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
// b) vérification des faits par un AUTRE fournisseur que celui qui a écrit : chaque phrase qui affirme un fait absent des sources
//    (ou contredit par elles) est corrigée d'après les sources, ou retirée. Si la vérification est impossible, le texte est gardé.
async function verifierFaits(texte, source, depart) {
  if (reste() < 5 * 60e3) return texte;
  let j;
  try {
    j = await ia("Tu es vérificateur de faits (fact-checker) pour une émission d'actualité. Réponds en JSON valide.",
      `Compare le TEXTE aux SOURCES. Liste chaque phrase du texte qui affirme un FAIT (nom, chiffre, date, lieu, citation, événement,
détail, « révélation ») ABSENT des sources ou CONTREDIT par elles, et chaque phrase qui présente comme coupable une personne non
condamnée, ou qui dédouble une même affaire. Les opinions présentées comme telles, les questions, l'humour et
les punchlines sans fait précis sont acceptés. Pour chaque phrase : "phrase" copiée EXACTEMENT, "correction" = la même phrase rendue
fidèle aux sources (même ton), ou "" si elle n'a pas de version fidèle.
Réponds : {"hors_sources": [{"phrase": "…", "correction": "…"}]} ([] si tout est fidèle).

TEXTE :
${texte}

SOURCES :
${source}`, { maxTokens: 3000, depart, temperature: 0.1, tours: 2 });
  } catch (e) { log(`    vérification des faits impossible (${String(e.message).slice(0, 80)}) : texte gardé`); return texte; }
  let n = 0;
  for (const c of j.hors_sources || []) {
    const ph = String(c.phrase || "").trim(); let rp = String(c.correction || "").trim();
    if (ph.length < 12 || !texte.includes(ph)) continue;
    if (rp && (NOUS.test(rp) || QUEMANDE.test(rp) || HORS_DOSSIER.test(rp) || !chiffresSurs(rp, source) || citationsSures(rp, source, true) !== rp)) rp = "";
    texte = texte.replace(ph, rp).replace(/\s{2,}/g, " ").trim(); n++;
  }
  if (n) log(`    vérification des faits : ${n} phrase(s) corrigée(s) ou retirée(s)`);
  return texte;
}

// ---------------------------------------------------------------- 3bis) écrire un dossier
const NOUS = /\b(nous|notre|nos)\b/i;
const HORS_DOSSIER = /\bbienvenue\b|dans les commentaires|en commentaire/i;     // l'accueil est dans l'ouverture seulement ; questions ouvertes, sans consigne
const ANGLES = [               // des ANGLES D'ANALYSE (opinion assumée) — jamais un prétexte pour inventer un fait « caché »
  "qui gagne, qui perd",
  "ton analyse de ce que ça révèle (présentée comme ton avis)",
  "la conséquence concrète pour le public",
  "le schéma qui se répète (seulement s'il est évident, sans inventer de précédent précis)",
  "la question qui fâche",
  "le détail le plus frappant DES SOURCES",
];
const QUEMANDE = /\b(likez|liker|partagez|abonnez|abonnez-vous|mettez un pouce|lâchez un like)\b|[ée]crivez\s+\S+\s+(dans le chat\s+)?si\b|tapez\s+\S+\s+si\b/i;
const chiffres = (s) => (String(s).match(/\d[\d\s.,]*\d|\d/g) || []).map((n) => n.replace(/[\s.,]/g, "")).filter((n) => n.length >= 2);
function chiffresSurs(texte, source) {
  const ok = new Set(chiffres(source));
  return chiffres(texte).every((n) => ok.has(n) || /^(19|20)\d\d$/.test(n) || n.length < 2);
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
  const n = g.note, rev = g.revendication, rumeur = n.categorie === "RUMEUR";
  const mots_cible = Math.round(Math.max(170, Math.min(520, 120 + g.texte.length / 25)));
  const j = await ia("Tu écris pour un live YouTube d'actualité choc (chaîne « Le Journal du NON »). Réponds en JSON valide.",
    `Écris le DOSSIER ci-dessous pour le présentateur, qui le lira au prompteur.
HUMOUR NOIR : jamais aux dépens des victimes (violences sexuelles, enfants, morts, sinistrés, malades) ; il vise les puissants,
les institutions, l'absurde. Aucune image sexuelle ou gore. Français impeccable : aucun mot inventé ou approximatif.
STYLE : expert géopolitique et analyste, choc, alarmiste mais factuel, humour noir en contrepoint (une touche, pas plus) ; oral,
phrases courtes ; mini-hook d'ouverture, les faits, UN angle de décryptage — ici : « ${ANGLES[rang % ANGLES.length]} » (n'utilise pas
d'autre formule toute faite), une punchline, puis UNE question ouverte au public.
Le dossier est lu au milieu du live : pas de « Bienvenue », pas de salut, pas de « dans les commentaires ».
HORS DU CONTEXTE : jamais « nous », « notre », « nos » ; dis « vous », « je ». Ne parle de la France ou des Français QUE si le sujet
les concerne directement (jamais de rapprochement forcé).
JAMAIS « likez », « partagez », « abonnez-vous », ni « écrivez X si… / tapez X si… ».
EXACTITUDE (protection juridique) : n'utilise QUE les faits des sources ci-dessous ; aucun chiffre, nom, date, citation ou détail
inventé, aucune « révélation » que les sources ne contiennent pas. Ton analyse est permise, mais présentée comme ton avis (« je pense »,
« à mon sens »), jamais comme un fait. Une citation entre guillemets doit figurer MOT POUR MOT dans les sources.
Une personne non condamnée n'est JAMAIS « meurtrier », « coupable », « violeur » : « accusé », « poursuivi », « soupçonné ».
Si les sources désignent la même affaire ou la même personne de plusieurs façons, c'est UNE seule affaire (ne la dédouble pas). Une
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
${g.texte}`, { maxTokens: 3500, depart, temperature: 0.45 });
  let texte = sansEtiquettes(String(j.texte || "").replace(/\s+\n/g, "\n").trim());
  // contrôle : phrases avec « nous », quémande de likes, ou chiffre absent des sources → retirées
  const phr = texte.split(/(?<=[.!?…])\s+/);
  const bonnes = phr.filter((p) => !NOUS.test(p) && !QUEMANDE.test(p) && !HORS_DOSSIER.test(p) && chiffresSurs(p, g.texte));
  if (bonnes.length < phr.length) log(`    ${phr.length - bonnes.length} phrase(s) retirée(s) (chiffre absent des sources, « nous », salut ou appel au like)`);
  texte = bonnes.join(" ");
  texte = citationsSures(texte, g.texte);
  texte = await verifierFaits(texte, g.texte, depart + 1);
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

// ---------------------------------------------------------------- 3ter) relecture d'ensemble (comme un rédacteur en chef)
// Lit TOUS les dossiers ensemble : phrase incohérente ou mot qui n'existe pas, humour aux dépens d'une victime, image sexuelle ou
// gore, affirmation non sourcée, contradiction entre deux dossiers. Seules les phrases citées EXACTEMENT sont remplacées (ou
// retirées) ; une correction illisible ou qui ajoute un chiffre absent des sources est ignorée. Jamais bloquant.
async function relire(dossiers) {
  if (reste() < 6 * 60e3) return;
  const corps = dossiers.map((d, i) => `### ${i + 1}. ${d.titre}\n${d.texte}`).join("\n\n");
  let j;
  try {
    j = await ia("Tu es rédacteur en chef et juriste d'une émission d'actualité française. Réponds en JSON valide.",
      `Relis ce script de live. Signale UNIQUEMENT les phrases à corriger :
- incohérente, mal construite, ou contenant un mot qui n'existe pas en français ;
- humour ou image aux dépens d'une victime (violences sexuelles, enfants, morts, sinistrés), image sexuelle ou gore ;
- affirmation présentée comme certaine sans source (au lieu de « selon… », « soupçonné », « présumé ») ;
- contradiction avec un autre dossier du script.
Pour chacune : "dossier" (numéro), "phrase" (copiée EXACTEMENT, mot pour mot), "remplacement" (phrase corrigée dans le même style,
sans ajouter aucun fait ni chiffre ; "" pour la supprimer).
Signale aussi les DOSSIERS qui racontent la même histoire (même attaque, même affaire, même loi) : "doublons" = paires de numéros.
Réponds : {"corrections": [{"dossier": 3, "phrase": "…", "remplacement": "…"}], "doublons": [[1, 10]]} ([] si rien).

${corps}`, { maxTokens: 5000 });
  } catch (e) { log(`  relecture d'ensemble impossible (${e.message}) : script gardé tel quel`); return; }
  let n = 0;
  for (const c of j.corrections || []) {
    const d = dossiers[Number(c.dossier) - 1], ph = String(c.phrase || "").trim(), rp = String(c.remplacement || "").trim();
    if (!d || ph.length < 12 || !d.texte.includes(ph)) continue;
    if (rp && (NOUS.test(rp) || QUEMANDE.test(rp) || HORS_DOSSIER.test(rp) || !chiffres(rp).every((x) => chiffres(d.texte).includes(x)))) continue;
    d.texte = d.texte.replace(ph, rp).replace(/\s{2,}/g, " ").trim(); n++;
  }
  // doublons repérés : on garde le dossier le plus sourcé (puis le plus long), l'autre est retiré du live
  const retirer = new Set();
  for (const p of j.doublons || []) {
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
    hab = await ia("Tu écris pour un live YouTube d'actualité choc (« Le Journal du NON »). Réponds en JSON valide.",
      `Voici les dossiers du live, dans l'ordre. Écris :
- "ouverture" (90 à 150 mots) : hook ultra-choc construit sur le dossier 1, teaser de la bombe finale (dernier dossier) sans la dévoiler,
  puis la phrase d'accueil exacte « Bienvenue dans le Journal du NON, et la réponse est Non. », puis une question ouverte au public ;
- "transitions" : pour chaque dossier à partir du 2e, UNE phrase (10 à 25 mots) qui fait le lien avec le précédent et accroche ;
- "cloture" (60 à 110 mots) : la bombe est passée, synthèse percutante, question ouverte au public, rendez-vous au prochain live SANS date.
Règles : jamais « nous / notre / nos », jamais « likez / partagez / abonnez-vous », jamais « écrivez X si… », jamais « dans les
commentaires ». Ne parle de la France que si un dossier la concerne. Rien d'inventé.
Réponds : {"ouverture": "…", "transitions": ["…", …], "cloture": "…"}

${ordre.map((d, i) => `${i + 1}. [${d.categorie}] ${d.titre} — ${d.teaser || d.faits[0] || ""}`).join("\n")}`, { maxTokens: 3000 });
  } catch (e) { log(`  ouverture/transitions impossibles (${e.message}) : repli sobre`); }
  const propre = (s, accueil = false) => String(s || "").split(/(?<=[.!?…])\s+/)
    .filter((p) => !NOUS.test(p) && !QUEMANDE.test(p) && !/dans les commentaires|en commentaire/i.test(p) && (accueil || !/\bbienvenue\b/i.test(p))).join(" ").trim();
  return {
    ordre,
    ouverture: propre(hab.ouverture, true) || "Bienvenue dans le Journal du NON, et la réponse est Non. L'actualité du jour ne va pas vous rassurer.",
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
  // AUDIENCE FRANÇAISE : la France d'abord ; l'international seulement s'il mérite vraiment l'attention des Français (≥ 7/10),
  // et jamais plus de 40 % des dossiers
  const enFrance = (g) => /^france$/i.test(String(g.note.pays || "").trim());
  const interet = (g) => (enFrance(g) ? 10 : Number(g.note.interet_fr) || 0);
  const score = (g) => Number(g.note.choc) + 0.6 * interet(g) + (g.officiel ? 0.5 : 0) + Math.min(1.5, g.nb_sources * 0.25);
  const candidats = solides.filter((g) => g.note.actuel !== false && Number(g.note.choc) >= Number(process.env.WARROOM_SEUIL || 6) && interet(g) >= 7)
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_DOSSIERS + 25);
  const uniques = await fusionner(candidats);
  const maxMonde = Math.max(2, Math.floor((MAX_DOSSIERS + 6) * 0.4));
  let nMonde = 0;
  const retenus = uniques.filter((g) => enFrance(g) || nMonde++ < maxMonde).slice(0, MAX_DOSSIERS + 6);   // quelques réserves si un dossier ne tient pas
  log(`  ${retenus.filter(enFrance).length} sujets France, ${retenus.filter((g) => !enFrance(g)).length} internationaux qui concernent la France`);
  log(`${solides.length} sujets solides (≥ 2 sources ou source officielle), ${retenus.length} assez choc retenus`);
  // ÉCRITURE EN PARALLÈLE : WARROOM_VOIES dossiers à la fois (3 par défaut), répartis entre fournisseurs (Gemini / Groq) ;
  // un modèle saturé est mis en pause pour toutes les voies, qui passent alors au modèle suivant. L'ordre des dossiers est conservé.
  const VOIES = Math.max(1, Number(process.env.WARROOM_VOIES || 3));
  const ecrits = new Map();
  let suivant = 0, ok = 0;
  async function voie(v) {
    while (suivant < retenus.length && ok < MAX_DOSSIERS && reste() > 8 * 60e3) {
      const i = suivant++, g = retenus[i];
      await enrichir(g);
      try {
        const d = await ecrireDossier(g, i, v);
        if (ok >= MAX_DOSSIERS) break;
        ok++; ecrits.set(i, d); log(`  ✓ [${d.categorie}] ${d.titre} (${d.texte.split(/\s+/).length} mots, ${g.nb_sources} sources)`);
      } catch (e) { log(`  ✗ ${g.items[0].titre.slice(0, 80)} : ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: VOIES }, (_, v) => voie(v)));
  const dossiers = [...ecrits.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d);
  if (!dossiers.length) throw new Error("aucun dossier assez solide aujourd'hui (sources ou IA indisponibles) : relance plus tard");
  await relire(dossiers);
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
