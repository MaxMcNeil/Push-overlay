// scripts/warroom/collect.mjs — WAR ROOM DU JOUR, étape 1 : ratisser l'actu des dernières 24 h (monde entier).
// Sources gratuites, sans clé, chacune facultative (une source en panne n'arrête jamais rien) :
//   presse : Google News (fr + en, par thème) et GDELT (presse mondiale, plus de 100 langues, articles au ton très négatif)
//   cyber  : ransomware.live (attaques confirmées par la presse + revendications des sites de fuite du dark web),
//            HaveIBeenPwned (nouvelles fuites de données), CISA (failles exploitées en ce moment)
//   catastrophes : USGS (séismes), GDACS (catastrophes, alertes orange/rouge)
//   rumeurs : vérifications des fact-checkeurs (ce qui circule, et ce qui est vrai)
// Sortie : output/warroom/brut.json = [{ titre, url, source, date, resume, origine, officiel, revendication? }]
import { mkdirSync, writeFileSync } from "fs";

const OUT = "output/warroom";
const H24 = 26 * 3600 * 1000;                       // fenêtre : 26 h (marge de fuseau)
const UA = { "user-agent": "Mozilla/5.0 (compatible; WarRoomBot/1.0; +https://github.com/MaxMcNeil/Push-overlay)" };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const etat = {};

async function get(url, { json = false, timeout = 25000, essais = 2 } = {}) {
  for (let k = 0; k < essais; k++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (r.status === 429 || r.status >= 500) { await dormir(3000 * (k + 1)); continue; }
      if (!r.ok) return null;
      return json ? await r.json() : await r.text();
    } catch { await dormir(1500); }
  }
  return null;
}
const recent = (d) => { const t = Date.parse(d); return isFinite(t) && Date.now() - t < H24 && t < Date.now() + 3600e3; };
const txt = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
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
  for (const [theme, qs] of Object.entries(THEMES)) {
    for (const q of qs) {
      const fr = theme !== "monde";
      const hl = fr ? "hl=fr&gl=FR&ceid=FR:fr" : "hl=en-US&gl=US&ceid=US:en";
      const x = await get(q ? `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&${hl}`
        : `https://news.google.com/rss/headlines/section/topic/NATION?${hl}`);          // « France » : la une nationale
      if (!x) continue;
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

// ---------------------------------------------------------------- presse mondiale : GDELT (ton très négatif = choc)
async function gdelt() {
  const out = [];
  const qs = ["(killed OR dead OR massacre OR disaster OR explosion)", "(scandal OR corruption OR leaked OR exposed OR arrested)",
    "(cyberattack OR hackers OR ransomware OR breach)", "(missile OR airstrike OR invasion OR coup)"];
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

export async function collecter() {
  mkdirSync(OUT, { recursive: true });
  const parts = await Promise.all([googleNews(), gdelt(), cyber(), catastrophes()].map((p) => p.catch((e) => { console.log(`  source en panne : ${e.message}`); return []; })));
  const tout = parts.flat();
  // doublons exacts (même lien ou même titre)
  const vus = new Set(), uniq = [];
  for (const x of tout) { const k = (x.url || "") + "|" + x.titre.toLowerCase().slice(0, 90); if (vus.has(k)) continue; vus.add(k); uniq.push(x); }
  writeFileSync(`${OUT}/brut.json`, JSON.stringify(uniq, null, 1));
  console.log(`Collecte : ${uniq.length} éléments des dernières 24 h — ` + Object.entries(etat).map(([k, v]) => `${k} ${v}`).join(", "));
  return { items: uniq, etat };
}

if (process.argv[1] && process.argv[1].endsWith("collect.mjs")) await collecter();
