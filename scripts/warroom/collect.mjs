// scripts/warroom/collect.mjs — WAR ROOM DU JOUR, étape 1 : ratisser l'actu des dernières 24 h (monde entier).
// Sources gratuites, sans clé, chacune facultative (une source en panne n'arrête jamais rien) :
//   presse : Google News (fr + en, par thème) et GDELT (presse mondiale, plus de 100 langues, articles au ton très négatif)
//   cyber  : ransomware.live (attaques confirmées par la presse + revendications des sites de fuite du dark web),
//            HaveIBeenPwned (nouvelles fuites de données), CISA (failles exploitées en ce moment)
//   catastrophes : USGS (séismes), GDACS (catastrophes, alertes orange/rouge)
//   rumeurs : vérifications des fact-checkeurs (ce qui circule, et ce qui est vrai)
// Sortie : output/warroom/brut.json = [{ titre, url, source, date, resume, origine, officiel, revendication? }]
import { mkdirSync, writeFileSync, existsSync } from "fs";

const OUT = "output/warroom";
const H24 = 26 * 3600 * 1000;                       // fenêtre : 26 h (marge de fuseau)
const UA = { "user-agent": "Mozilla/5.0 (compatible; WarRoomBot/1.0; +https://github.com/MaxMcNeil/Push-overlay)" };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const etat = {};
const statuts = {};          // dernier code HTTP par site (pour dire pourquoi une source ne donne rien)

async function get(url, { json = false, timeout = 25000, essais = 2 } = {}) {
  for (let k = 0; k < essais; k++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      statuts[new URL(url).hostname] = r.status;
      if (r.status === 429 || r.status >= 500) { await dormir(3000 * (k + 1)); continue; }
      if (!r.ok) return null;
      return json ? await r.json() : await r.text();
    } catch { await dormir(1500); }
  }
  return null;
}
const recent = (d, h = 26) => { const t = Date.parse(d); return isFinite(t) && Date.now() - t < h * 3600e3 && t < Date.now() + 3600e3; };
const ENT = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", ndash: "–", mdash: "—", laquo: "«", raquo: "»" };

for (const [b, l] of Object.entries({ a: "àâä", e: "èéêë", i: "îï", o: "ôö", u: "ùûü", c: "ç" })) { const g = { a: ["agrave", "acirc", "auml"], e: ["egrave", "eacute", "ecirc", "euml"], i: ["icirc", "iuml"], o: ["ocirc", "ouml"], u: ["ugrave", "ucirc", "uuml"], c: ["ccedil"] }[b]; [...l].forEach((ch, k) => { ENT[g[k]] = ch; ENT[g[k][0].toUpperCase() + g[k].slice(1)] = ch.toUpperCase(); }); }
ENT.oelig = "œ"; ENT.OElig = "Œ"; ENT.euro = "€"; ENT.deg = "°";
export const deshtml = (s) => String(s || "").replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? ENT[n.toLowerCase()] ?? m);
const txt = (s) => deshtml(deshtml(String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")))
  .replace(/\s+/g, " ").trim();
const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")) || [])[1] || "";

// ---------------------------------------------------------------- presse : Google News (par thème, fr + en)
// AUDIENCE FRANÇAISE : d'abord l'actu de France (édition France de Google News), puis le grand international qui la concerne.
// Les requêtes en anglais ne servent qu'aux très gros événements mondiaux (le tri écarte ensuite ce qui n'intéresse pas la France).
const THEMES = {
  france: ["", "polémique gouvernement", "scandale ministre", "Assemblée nationale scandale", "perquisition OR garde à vue personnalité",
    "mis en examen OR condamné élu", "émeutes OR violences urbaines", "colère agriculteurs OR grève OR blocage", "hausse des prix colère OR facture",
    "fermeture usine licenciements", "narcotrafic OR règlement de comptes", "agression OR attaque au couteau", "féminicide OR meurtre",
    "drame enfant OR bébé", "hôpital urgences drame", "police bavure OR policiers attaqués", "prison évasion OR détenus",
    "immigration polémique", "insécurité quartier", "Marseille OR Paris OR Lyon drame"],
  catastrophe: ["catastrophe morts", "séisme OR inondation OR tempête victimes", "incendie meurtrier"],
  accident: ["accident grave morts", "crash avion OR déraillement OR naufrage", "explosion morts"],
  scandale: ["scandale corruption", "mis en examen détournement", "fraude milliards", "affaire révélations Mediapart OR Canard enchaîné"],
  geopolitique: ["frappe militaire escalade", "missile attaque OTAN", "guerre Ukraine Russie", "Iran Israël escalade", "menace nucléaire"],
  revelations: ["révélations documents fuite", "enquête révèle", "lanceur d'alerte"],
  cyber: ["cyberattaque France", "fuite de données clients France", "piratage données santé OR mairie OR hôpital", "rançongiciel"],
  insolite: ["insolite incroyable"],
  rumeurs: ["rumeur virale démentie", "théorie du complot", "fausse information réseaux sociaux"],
  monde: ["deadly disaster", "military strike escalation", "leaked documents reveal", "ransomware attack", "mass shooting"],
};
async function googleNews() {
  const out = [];
  let echecs = 0;
  for (const [theme, qs] of Object.entries(GOLFE ? THEMES_GOLFE : THEMES)) {
    for (const q of qs) {
      const fr = !GOLFE && theme !== "monde";
      const hl = fr ? "hl=fr&gl=FR&ceid=FR:fr" : "hl=en-US&gl=US&ceid=US:en";
      if (out.length === 0 && echecs >= 4) break;                 // Google News bloque ce serveur : inutile d'insister
      const x = await get(q ? `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&${hl}`
        : `https://news.google.com/rss/headlines/section/topic/NATION?${hl}`);          // « France » : la une nationale
      if (!x) { echecs++; continue; }
      for (const it of x.split("<item>").slice(1, 16)) {
        const date = tag(it, "pubDate"), titre = txt(tag(it, "title")), source = txt(tag(it, "source"));
        if (!titre || !recent(date)) continue;
        out.push({ titre: titre.replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), ""), url: txt(tag(it, "link")), source,
          date: new Date(date).toISOString(), resume: txt(tag(it, "description")).slice(0, 400), origine: "googlenews", theme, langue: fr ? "fr" : "en" });
      }
      await dormir(400);
    }
  }
  etat.googlenews = out.length;
  if (!out.length) console.log(`  Google News ne répond pas à ce serveur (code ${statuts["news.google.com"] ?? "aucun"}) : la presse française directe prend le relais`);
  return out;
}

// GDELT répond parfois en texte (limite de débit, requête refusée) : le motif est écrit dans le journal, et un essai de plus
async function getGdelt(url, o) {
  for (let k = 0; k < 2; k++) {
    const t = await get(url, { ...o, json: false });
    if (t == null) { console.log("  GDELT : pas de réponse"); continue; }
    try { return JSON.parse(t); } catch { console.log(`  GDELT : ${t.slice(0, 160).replace(/\s+/g, " ")}`); await dormir(8000); }
  }
  return null;
}

// ÉDITION GOLFE (WARROOM_EDITION=golfe, chaîne Gulf Think-Tank) : public des 6 pays du Golfe ; le monde seulement s'il touche le Golfe
export const GOLFE = process.env.WARROOM_EDITION === "golfe";
const THEMES_GOLFE = {
  golfe: ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Oman", "Bahrain", "GCC Gulf summit", "Riyadh OR Abu Dhabi OR Doha announcement",
    "Gulf investment deal billion", "Saudi Vision 2030", "OPEC oil price", "Strait of Hormuz", "Red Sea shipping attack"],
  region: ["Iran Gulf tension", "Yemen Houthi", "Israel Gaza", "Lebanon Hezbollah", "Syria", "Iraq militia", "Sudan war", "Egypt crisis"],
  monde: ["US Middle East policy", "Russia Ukraine war", "China Gulf", "military strike escalation", "leaked documents reveal", "deadly disaster",
    "ransomware attack Gulf OR Middle East"],
};
const FLUX_GOLFE = [
  ["Gulf News (EAU)", "https://gulfnews.com/feed/"],
  ["The National (EAU)", "https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml"],
  ["Khaleej Times (EAU)", "https://www.khaleejtimes.com/arc/outboundfeeds/rss/?outputType=xml"],
  ["Arab News (Arabie saoudite)", "https://www.arabnews.com/rss.xml"],
  ["Saudi Gazette", "https://saudigazette.com.sa/rssFeed/74"],
  ["Gulf Times (Qatar)", "https://www.gulf-times.com/rssFeed/8"],
  ["The Peninsula (Qatar)", "https://thepeninsulaqatar.com/rss"],
  ["Times of Oman", "https://timesofoman.com/rss"],
  ["Kuwait Times", "https://kuwaittimes.com/feed/"],
  ["Gulf Daily News (Bahreïn)", "https://www.gdnonline.com/rss"],
  ["Al Jazeera English", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["Middle East Eye", "https://www.middleeasteye.net/rss"],
  ["Al-Monitor", "https://www.al-monitor.com/rss"],
  ["Asharq Al-Awsat (anglais)", "https://english.aawsat.com/feed"],
  ["Al Arabiya (anglais)", "https://english.alarabiya.net/feed/rss2/en.xml"],
  ["SPA (agence saoudienne)", "https://www.spa.gov.sa/en/rss"],
  ["WAM (agence émiratie)", "https://www.wam.ae/en/rss"],
  ["QNA (agence qatarie)", "https://www.qna.org.qa/en/rss"],
  ["Reuters Moyen-Orient (via Google)", "https://news.google.com/rss/search?q=site:reuters.com+middle+east+when:1d&hl=en-US&gl=US&ceid=US:en"],
  ["BBC Moyen-Orient", "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml"],

  // + catalogue « World Monitor » (koala73/worldmonitor) : presse internationale, Moyen-Orient, investissements du Golfe, énergie, défense
  ["BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["Guardian World", "https://www.theguardian.com/world/rss"],
  ["AP News", "https://news.google.com/rss/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US:en"],
  ["Reuters World", "https://news.google.com/rss/search?q=site%3Areuters.com%20world%20when%3A1d&hl=en-US&gl=US&ceid=US:en"],
  ["New York Times World", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  ["Washington Post World", "https://feeds.washingtonpost.com/rss/world"],
  ["The Independent", "https://www.independent.co.uk/news/world/rss"],
  ["Guardian ME", "https://www.theguardian.com/world/middleeast/rss"],
  ["Arab News (Golfe)", "https://news.google.com/rss/search?q=site%3Aarabnews.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en"],
  ["Arab News (Golfe)", "https://news.google.com/rss/search?q=site%3Aarabnews.com%20(Saudi%20Arabia%20OR%20investment%20OR%20infrastructure)%20when%3A7d&hl=en-US&gl=US&ceid=US:en"],
  ["The National (Golfe)", "https://news.google.com/rss/search?q=site%3Athenationalnews.com%20(Abu%20Dhabi%20OR%20UAE%20OR%20Saudi)%20when%3A7d&hl=en-US&gl=US&ceid=US:en"],
  ["Oman Observer", "https://www.omanobserver.om/rssFeed/1"],
  ["Asharq Business", "https://asharqbusiness.com/rss.xml"],
  ["Sana'a Center", "https://sanaacenter.org/feed/"],
  ["Syria Direct", "https://syriadirect.org/feed/"],
  ["Naharnet Lebanon", "https://www.naharnet.com/tags/lebanon/en/feed.atom"],
  ["Egypt Independent", "https://www.egyptindependent.com/feed/"],
  ["Foreign Policy", "https://foreignpolicy.com/feed/"],
  ["Arabian Business", "https://news.google.com/rss/search?q=site%3Aarabianbusiness.com%20(Saudi%20Arabia%20OR%20UAE%20OR%20GCC)%20when%3A7d&hl=en-US&gl=US&ceid=US:en"],
  ["Gulf FDI", "https://news.google.com/rss/search?q=(PIF%20OR%20%22DP%20World%22%20OR%20Mubadala%20OR%20ADNOC%20OR%20Masdar%20OR%20%22ACWA%20Power%22)%20infrastructure%20when%3A7d&hl=en-US&gl=US&ceid=US:en"],
  ["Gulf Investments", "https://news.google.com/rss/search?q=(%22Saudi%20Arabia%22%20OR%20UAE%20OR%20%22Abu%20Dhabi%22)%20investment%20infrastructure%20when%3A7d&hl=en-US&gl=US&ceid=US:en"],
  ["Vision 2030", "https://news.google.com/rss/search?q=%22Vision%202030%22%20(project%20OR%20investment%20OR%20announced)%20when%3A14d&hl=en-US&gl=US&ceid=US:en"],
  ["OilPrice.com", "https://oilprice.com/rss/main"],
  ["The War Zone", "https://www.twz.com/feed"],
  ["USNI News", "https://news.google.com/rss/search?q=site:news.usni.org+when:3d&hl=en-US&gl=US&ceid=US:en"],
  ["gCaptain", "https://gcaptain.com/feed/"],
  ["IRNA", "https://en.irna.ir/rss"],
  ["Mehr News", "https://en.mehrnews.com/rss"],
  ["OPEC & Crude", "https://news.google.com/rss/search?q=(OPEC+OR+\"oil+price\"+OR+\"crude+oil\"+OR+WTI+OR+Brent+OR+\"oil+production\"+OR+\"oil+inventory\")+when:1d&hl=en-US&gl=US&ceid=US:en"],
  ["Pipelines & Chokepoints", "https://news.google.com/rss/search?q=(pipeline+OR+Druzhba+OR+\"Nord+Stream\"+OR+TurkStream+OR+\"Strait+of+Hormuz\"+OR+\"Bab+el-Mandeb\"+OR+\"Suez+Canal\"+OR+\"Power+of+Siberia\")+when:2d&hl=en-US&gl=US&ceid=US:en"],
  ["Middle East Institute", "https://news.google.com/rss/search?q=site:mei.edu+when:7d&hl=en-US&gl=US&ceid=US:en"],
  ["Daily News Egypt", "https://www.dailynewsegypt.com/feed/"],
  ["Doha News", "https://dohanews.co/feed/"],
  ["Jordan News", "https://www.jordannews.jo/rss"],
  ["Khaleej Times", "https://www.khaleejtimes.com/api/v1/collections/top-section.rss"],
  ["Palestine News Network", "https://english.pnn.ps/feed"],
  ["The Syrian Observer", "https://syrianobserver.com/feed"],
  ["NPR World", "https://feeds.npr.org/1004/rss.xml"],
];

// ---------------------------------------------------------------- presse française en direct (flux RSS des rédactions)
// Toujours collectée (en plus de Google News, et seule si Google News bloque) : liens DIRECTS vers les articles, que l'écriture
// peut lire en entier. Un flux qui ne répond pas est simplement ignoré.
const FLUX = [
  ["franceinfo", "https://www.francetvinfo.fr/titres.rss"],
  ["Le Monde", "https://www.lemonde.fr/rss/une.xml"],
  ["Le Monde (France)", "https://www.lemonde.fr/societe/rss_full.xml"],
  ["Le Figaro", "https://www.lefigaro.fr/rss/figaro_actualites.xml"],
  ["Le Figaro (France)", "https://www.lefigaro.fr/rss/figaro_actualite-france.xml"],
  ["BFMTV", "https://www.bfmtv.com/rss/news-24-7/"],
  ["20 Minutes", "https://www.20minutes.fr/feeds/rss-une.xml"],
  ["Ouest-France", "https://www.ouest-france.fr/rss/une"],
  ["Libération", "https://www.liberation.fr/arc/outboundfeeds/rss/?outputType=xml"],
  ["L'Express", "https://www.lexpress.fr/arc/outboundfeeds/rss/alaune.xml"],
  ["Le Point", "https://www.lepoint.fr/rss.xml"],
  ["Le Parisien", "https://feeds.leparisien.fr/leparisien/rss"],
  ["Europe 1", "https://www.europe1.fr/rss.xml"],
  ["RFI", "https://www.rfi.fr/fr/rss"],
  ["France 24", "https://www.france24.com/fr/rss"],
  ["Mediapart", "https://www.mediapart.fr/articles/feed"],
];
async function presseFr() {
  const out = [], vides = [];
  await Promise.all((GOLFE ? FLUX_GOLFE : FLUX).map(async ([nom, url]) => {
    const x = await get(url, { timeout: 20000 });
    if (!x) { vides.push(nom); return; }
    const items = x.includes("<item") ? x.split(/<item[\s>]/).slice(1) : x.split(/<entry[\s>]/).slice(1);
    let n = 0;
    for (const it of items.slice(0, 60)) {
      const titre = txt(tag(it, "title")), date = tag(it, "pubDate") || tag(it, "dc:date") || tag(it, "updated") || tag(it, "published");
      const lien = txt(tag(it, "link")) || ((it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "");
      if (!titre || !recent(date)) continue;
      out.push({ titre, url: lien, source: nom, date: new Date(date).toISOString(), resume: txt(tag(it, "description")).slice(0, 400), origine: GOLFE ? "presse-golfe" : "presse-fr", langue: GOLFE ? "en" : "fr" });
      n++;
    }
    if (!n) vides.push(nom);
  }));
  etat.presse_fr = out.length;
  if (vides.length) console.log(`  flux sans article récent ou injoignables : ${vides.join(", ")}`);
  return out;
}

// ---------------------------------------------------------------- AUTRES LECTURES : presse étrangère et indépendante
// Ces flux ne créent pas de dossiers : ils servent de « contre-lecture » (ce que disent d'autres camps, d'autres pays, d'autres
// rédactions) pour les dossiers retenus, toujours cités avec leur nom. Un flux injoignable est simplement ignoré.
const AUTRES = [
  ["Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["Middle East Eye", "https://www.middleeasteye.net/rss"],
  ["Responsible Statecraft", "https://responsiblestatecraft.org/feed/"],
  ["Consortium News", "https://consortiumnews.com/feed/"],
  ["The Grayzone", "https://thegrayzone.com/feed/"],
  ["The Intercept", "https://theintercept.com/feed/?rss"],
  ["Mondafrique", "https://mondafrique.com/feed/"],
  ["Les Crises", "https://www.les-crises.fr/feed/"],
  ["Blast", "https://www.blast-info.fr/feed"],
  ["Le Monde diplomatique", "https://www.monde-diplomatique.fr/rss/"],
  ["Anadolu (FR)", "https://www.aa.com.tr/fr/rss/default?cat=actualite"],
  ["Press TV (Iran)", "https://www.presstv.ir/rss.xml"],
  ["TASS (Russie)", "https://tass.com/rss/v2.xml"],
  ["Global Times (Chine)", "https://www.globaltimes.cn/rss/outbrain.xml"],
  ["Haaretz", "https://www.haaretz.com/srv/haaretz-latest-headlines"],
  // ajoutés le 25/11/2026 depuis le catalogue du projet open source « World Monitor » (koala73/worldmonitor) — un flux mort ou
  // bloqué est simplement ignoré. Enquêtes, terrain des conflits, l'autre camp (cité comme tel), le monde vu de chez lui.
  ["Courrier international", "https://www.courrierinternational.com/feed/all/rss.xml"],
  ["OCCRP (enquêtes corruption)", "https://www.occrp.org/en/feed"],
  ["Lighthouse Reports", "https://www.lighthousereports.com/feed/"],
  ["ProPublica", "https://www.propublica.org/feeds/propublica/main"],
  ["Oryx (pertes militaires documentées)", "https://www.oryxspioenkop.com/feeds/posts/default?alt=rss"],
  ["International Crisis Group", "https://www.crisisgroup.org/rss"],
  ["War on the Rocks", "https://warontherocks.com/feed/"],
  ["Sudan War Monitor", "https://sudanwarmonitor.com/feed"],
  ["ONU Info (UN News)", "https://news.un.org/feed/subscribe/en/news/all/rss.xml"],
  ["RAND", "https://www.rand.org/pubs/articles.xml"],
  ["Stimson Center", "https://www.stimson.org/feed/"],
  ["Atlantic Council", "https://www.atlanticcouncil.org/feed/"],
  ["CSIS", "https://www.csis.org/rss.xml"],
  ["Meduza (opposition russe)", "https://meduza.io/rss/en/all"],
  ["Moscow Times", "https://www.themoscowtimes.com/rss/news"],
  ["Novaya Gazeta Europe", "https://novayagazeta.eu/feed/rss"],
  ["RT (média d'État russe)", "https://rt-english.com/rss/russia/"],
  ["Kyiv Independent", "https://kyivindependent.com/news-archive/rss/"],
  ["Eurasianet", "https://eurasianet.org/rss"],
  ["LRT (Lituanie)", "https://www.lrt.lt/en/news-in-english?rss"],
  ["IRNA (agence d'État iranienne)", "https://en.irna.ir/rss"],
  ["Mehr News (Iran)", "https://en.mehrnews.com/rss"],
  ["Syria Direct", "https://syriadirect.org/feed/"],
  ["The Syrian Observer", "https://syrianobserver.com/feed"],
  ["Naharnet (Liban)", "https://www.naharnet.com/tags/lebanon/en/feed.atom"],
  ["Jerusalem Post", "https://www.jpost.com/rss/rssfeedsheadlines.aspx"],
  ["The National (Émirats)", "https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml"],
  ["Gulf News", "https://gulfnews.com/feed/"],
  ["Daily Sabah (Turquie)", "https://www.dailysabah.com/rss/home-page"],
  ["Libya Herald", "https://libyaherald.com/rss.xml"],
  ["Egypt Independent", "https://www.egyptindependent.com/feed/"],
  ["Jeune Afrique", "https://www.jeuneafrique.com/feed/"],
  ["Journal du Mali", "https://journaldumali.com/feed/"],
  ["Sahelien.com", "https://sahelien.com/feed/"],
  ["Le Sahel (Niger)", "https://www.lesahel.org/feed/"],
  ["APS (Sénégal)", "https://aps.sn/feed/"],
  ["La Presse de Tunisie", "https://www.lapresse.tn/feed/"],
  ["Africanews", "https://www.africanews.com/feed/"],
  ["Dawn (Pakistan)", "https://www.dawn.com/feeds/home/"],
  ["The Hindu (Inde)", "https://www.thehindu.com/feeder/default.rss"],
  ["Asahi Shimbun (Japon)", "https://www.asahi.com/rss/asahi/newsheadlines.rdf"],
  ["Korea Herald", "https://www.koreaherald.com/rss/newsAll"],
];
export async function autresLectures() {
  const out = [], ok = [];
  await Promise.all(AUTRES.map(async ([nom, url]) => {
    const x = await get(url, { timeout: 20000 });
    if (!x) return;
    const items = x.includes("<item") ? x.split(/<item[\s>]/).slice(1) : x.split(/<entry[\s>]/).slice(1);
    let n = 0;
    for (const it of items.slice(0, 80)) {
      const titre = txt(tag(it, "title")), date = tag(it, "pubDate") || tag(it, "dc:date") || tag(it, "updated") || tag(it, "published");
      const lien = txt(tag(it, "link")) || ((it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "");
      if (!titre || (date && !recent(date, 72))) continue;
      out.push({ titre, url: lien, source: nom, resume: txt(tag(it, "description")).slice(0, 500), origine: "autre-lecture" });
      n++;
    }
    if (n) ok.push(nom);
  }));
  etat.autres_lectures = out.length;
  console.log(`  autres lectures (presse étrangère / indépendante) : ${out.length} articles de ${ok.length} sources`);
  return out;
}

// ---------------------------------------------------------------- DÉCLARATIONS DIRECTES (leurs propres mots, avant la presse)
// Donald Trump sur Truth Social, via le miroir public trumpstruth.org (flux trouvé dans le catalogue de « World Monitor »).
// Source officielle (le président américain qui s'exprime) : le sujet peut exister même avant que la presse le reprenne ;
// l'écriture l'attribue toujours (« a écrit Donald Trump sur Truth Social »). Flux en panne = ignoré.
const DECLARATIONS = [["Truth Social (Donald Trump)", "https://trumpstruth.org/feed"]];
async function declarations() {
  const out = [];
  for (const [nom, url] of DECLARATIONS) {
    const x = await get(url, { timeout: 20000 });
    if (!x) continue;
    for (const it of x.split(/<item[\s>]/).slice(1, 60)) {
      const date = tag(it, "pubDate") || tag(it, "dc:date");
      if (!date || !recent(date)) continue;
      const desc = txt(tag(it, "description")).replace(/https?:\/\/\s*\S+/g, "").replace(/\s+/g, " ").trim();
      let titre = txt(tag(it, "title")).replace(/https?:\/\/\s*\S+/g, "").trim();
      if (!titre || /^\[?no title\]?|^post from|^truth\b/i.test(titre) || titre.length < 30) titre = desc;
      if (!titre || titre.length < 40 || (titre.match(/\p{L}{2,}/gu) || []).length < 7 || /^RT\b|^ReTruth/i.test(titre)) continue;       // repartage ou message vide : ignoré
      out.push({ titre: titre.slice(0, 300), url: txt(tag(it, "link")), source: nom, date: new Date(date).toISOString(), resume: desc.slice(0, 600),
        origine: "declaration", officiel: true, langue: "en", pays: "États-Unis" });
    }
  }
  etat.declarations = out.length;
  console.log(`  déclarations directes (Truth Social…) : ${out.length}`);
  return out;
}

// ---------------------------------------------------------------- presse mondiale : GDELT (ton très négatif = choc)
async function gdelt() {
  const out = [];
  const qs = ["(killed OR dead OR massacre OR disaster OR explosion)", "(scandal OR corruption OR leaked OR exposed OR arrested)",
    "(cyberattack OR hackers OR ransomware OR breach)", "(missile OR airstrike OR invasion OR coup)",
    ...(GOLFE ? ["(Saudi OR Emirates OR Qatar OR Kuwait OR Oman OR Bahrain OR Gulf)"] : [])];
  for (const q of qs) {
    const j = await getGdelt(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q + " tone<-6 sourcelang:english")}&mode=artlist&maxrecords=60&timespan=24h&sort=hybridrel&format=json`, { json: true, timeout: 40000 });
    for (const a of j?.articles || []) {
      const d = String(a.seendate || "").replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z");
      if (!a.title || !recent(d)) continue;
      out.push({ titre: txt(a.title), url: a.url, source: a.domain, date: d, resume: "", origine: "gdelt", pays_source: a.sourcecountry || "", langue: "en" });
    }
    await dormir(5500);              // GDELT : une requête toutes les 5 s au plus
  }
  etat.gdelt = out.length;
  return out;
}

// ---------------------------------------------------------------- cyber
async function cyber() {
  const out = [];
  const press = await get("https://api.ransomware.live/v2/recentcyberattacks", { json: true });
  for (const a of Array.isArray(press) ? press : []) {
    const d = a.date || a.added; if (!recent(d)) continue;
    out.push({ titre: txt(a.title || `Cyberattaque contre ${a.victim}`), url: a.url || "", source: a.domain || "presse (via ransomware.live)", date: new Date(d).toISOString(),
      resume: txt(a.summary || "").slice(0, 600), origine: "ransomware.live/presse", theme: "cyber", officiel: true, pays: a.country || "" });
  }
  const claims = await get("https://api.ransomware.live/v2/recentvictims", { json: true });
  for (const v of Array.isArray(claims) ? claims : []) {
    const d = v.discovered || v.attackdate; if (!recent(d)) continue;
    // REVENDICATION d'un groupe sur son site de fuite (dark web) : jamais présentée comme un fait établi
    out.push({ titre: `${v.group_name || v.group || "Un groupe de rançongiciel"} revendique une attaque contre ${v.post_title || v.victim}`, url: "",   // jamais de lien vers le dark web
      source: "site de fuite du groupe (relevé par ransomware.live)", date: new Date(d).toISOString(),
      resume: txt(v.description || "").slice(0, 400), origine: "ransomware.live/revendication", theme: "cyber", revendication: true,
      pays: v.country || "", secteur: v.activity || "", groupe: v.group_name || v.group || "" });
  }
  const hibp = await get("https://haveibeenpwned.com/api/v3/breaches", { json: true, timeout: 40000 });
  for (const b of Array.isArray(hibp) ? hibp : []) {
    if (!recent(b.AddedDate)) continue;
    out.push({ titre: `Fuite de données : ${b.Title} — ${Number(b.PwnCount || 0).toLocaleString("fr-FR")} comptes exposés`, url: `https://haveibeenpwned.com/PwnedWebsites#${b.Name}`,
      source: "Have I Been Pwned", date: new Date(b.AddedDate).toISOString(), resume: txt(b.Description).slice(0, 600), origine: "hibp", theme: "cyber", officiel: true,
      chiffre: Number(b.PwnCount || 0) });
  }
  const kev = await get("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", { json: true, timeout: 40000 });
  for (const v of kev?.vulnerabilities || []) {
    if (Date.now() - Date.parse(v.dateAdded) > 2 * 86400e3) continue;
    out.push({ titre: `Faille activement exploitée : ${v.vendorProject} ${v.product} (${v.cveID})`, url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`, source: "CISA (agence de cybersécurité américaine)",
      date: new Date(v.dateAdded).toISOString(), resume: txt(`${v.vulnerabilityName}. ${v.shortDescription}`).slice(0, 500), origine: "cisa", theme: "cyber", officiel: true });
  }
  etat.cyber = out.length;
  return out;
}

// ---------------------------------------------------------------- catastrophes : USGS + GDACS
async function catastrophes() {
  const out = [];
  const q = await get("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson", { json: true });
  for (const f of q?.features || []) {
    const p = f.properties || {}; if (!(p.mag >= 6 || p.alert === "orange" || p.alert === "red")) continue;   // (le champ « tsunami » de l'USGS n'est PAS une alerte : ignoré)
    const [lon, lat] = f.geometry?.coordinates || [];
    out.push({ titre: `Séisme de magnitude ${Math.round(p.mag * 10) / 10} — ${p.place}`, url: p.url, source: "USGS (institut géologique américain)",
      date: new Date(p.time).toISOString(), resume: `Magnitude ${Math.round(p.mag * 10) / 10}, profondeur ${Math.round(f.geometry?.coordinates?.[2] || 0)} km. Niveau d'alerte PAGER (victimes et dégâts estimés) : ${p.alert || "non publié"}.`,
      origine: "usgs", theme: "catastrophe", officiel: true, lat, lon, chiffre: p.mag });
  }
  const g = await get("https://www.gdacs.org/xml/rss_24h.xml");
  for (const it of (g || "").split("<item>").slice(1)) {
    const niveau = (tag(it, "gdacs:alertlevel") || "").toLowerCase();
    if (!["orange", "red"].includes(niveau)) continue;
    const date = tag(it, "pubDate"); if (!recent(date)) continue;
    out.push({ titre: txt(tag(it, "title")), url: txt(tag(it, "link")), source: "GDACS (ONU / Commission européenne)", date: new Date(date).toISOString(),
      resume: txt(tag(it, "description")).slice(0, 500), origine: "gdacs", theme: "catastrophe", officiel: true,
      lat: Number(tag(it, "geo:lat")) || undefined, lon: Number(tag(it, "geo:long")) || undefined, alerte: niveau });
  }
  etat.catastrophes = out.length;
  return out;
}

// ---------------------------------------------------------------- 📻 radios et émissions (menu du workflow, « non » par défaut)
// Les transcriptions sont faites AVANT, en parallèle, par les machines d'écoute (scripts/warroom/ecoute) ; ici on ne fait que les lire.
let _radios = null;
const radios = () => _radios || (_radios = lireRadios());
async function lireRadios() {
  const dir = "output/warroom/ecoute/transcriptions";
  if (!existsSync(dir)) return [];
  const { sujetsRadios } = await import("./ecoute/radios.mjs");
  const out = sujetsRadios(dir);
  etat.radios = out.length;
  console.log(`  radios et émissions : ${out.length} passage(s) alarmant(s) retenu(s)`);
  return out;
}

export async function collecter() {
  mkdirSync(OUT, { recursive: true });
  const contre = await autresLectures().catch(() => []);
  // les émissions indépendantes servent aussi de contre-lectures (toujours citées avec leur nom)
  try { contre.push(...(await radios()).map((x) => ({ source: x.source, titre: x.titre, resume: x.resume.slice(0, 400), url: x.url }))); } catch {}
  writeFileSync(`${OUT}/autres.json`, JSON.stringify(contre, null, 1));
  const parts = await Promise.all([presseFr(), googleNews(), gdelt(), cyber(), catastrophes(), declarations(), radios()].map((p) => p.catch((e) => { console.log(`  source en panne : ${e.message}`); return []; })));
  const tout = parts.flat();
  // doublons exacts (même lien ou même titre)
  const vus = new Set(), uniq = [];
  for (const x of tout) { const k = (x.url || "") + "|" + x.titre.toLowerCase().slice(0, 90); if (vus.has(k)) continue; vus.add(k); uniq.push(x); }
  writeFileSync(`${OUT}/brut.json`, JSON.stringify(uniq, null, 1));
  console.log(`Collecte : ${uniq.length} éléments des dernières 24 h — ` + Object.entries(etat).map(([k, v]) => `${k} ${v}`).join(", "));
  return { items: uniq, etat, contre };
}

if (process.argv[1] && process.argv[1].endsWith("collect.mjs")) await collecter();
