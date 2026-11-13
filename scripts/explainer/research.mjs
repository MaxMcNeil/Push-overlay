// scripts/explainer/research.mjs — « download search pour montages.txt » : de quoi illustrer ce que tu dis.
// Entrée : content/transcript.json (ta voix transcrite). Sortie : output/research/ :
//   - « download search pour montages.txt » : pour chaque moment fort de ta voix (avec son minutage) :
//       vidéos YouTube + passage précis (lien qui démarre au bon endroit) à filmer en enregistrement d'écran,
//       articles de presse (titre, média, date, lien), photos libres de droits téléchargées ;
//   - photos/NN-sujet.jpg : photos LIBRES DE DROITS (Wikimedia Commons, licence et auteur notés) prêtes à monter.
// Les photos de presse ne sont PAS téléchargées (droits d'auteur : risque de réclamation YouTube) : leurs articles sont en lien.
// IA : Groq (puis Claude) — jamais la clé Gemini pour la recherche. Rien ici ne peut faire échouer le montage.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { pathToFileURL } from "url";
import { callGroq, callClaude, groqKeys, keysOf, parseJson } from "../lib/llm.mjs";
import { sentencesOf } from "./plan.mjs";

const OUT = process.env.RESEARCH_OUT || "output/research";
const FILE = "download search pour montages.txt";
const MAX_MOMENTS = Number(process.env.RESEARCH_MAX_MOMENTS || 10);
const UA = "Mozilla/5.0 (compatible; Push-overlay-research/1.0; +https://github.com/MaxMcNeil/Push-overlay)";
const mmss = (t) => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`; };
const clean = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const get = async (url, opt = {}) => { try { const r = await fetch(url, { headers: { "user-agent": UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(opt.timeout || 25000) }); return r.ok ? r : null; } catch { return null; } };
const LANG = { ar: { hl: "ar", gl: "SA", ceid: "SA:ar" }, fr: { hl: "fr", gl: "FR", ceid: "FR:fr" }, en: { hl: "en-US", gl: "US", ceid: "US:en" }, it: { hl: "it", gl: "IT", ceid: "IT:it" } };

// ---------------------------------------------------------------- 1) moments forts de la voix (IA texte, par blocs)
function blocks(sents, maxChars = 3200) {
  const out = []; let cur = [];
  for (const s of sents) { cur.push(s); if (cur.map((x) => x.text).join(" ").length > maxChars) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out;
}
async function askText(sys, user) {
  const list = [groqKeys().length ? ["groq", callGroq] : null, process.env.ANTHROPIC_API_KEY ? ["claude", callClaude] : null].filter(Boolean);
  for (const [name, fn] of list) {
    try { const j = parseJson(await fn(sys, user, { temperature: 0.2, maxTokens: 2500, timeoutMs: 120000, deadline: Date.now() + 150000 })); if (j) return j; }
    catch (e) { console.log(`  recherche : IA ${name} indisponible (${String(e.message).slice(0, 90)})`); }
  }
  return null;
}
export async function moments(sents, lang) {
  const bl = blocks(sents);
  const per = Math.max(2, Math.ceil(MAX_MOMENTS / bl.length));
  const sys = `Tu prépares le montage d'une vidéo d'actualité/géopolitique. On te donne la voix off en phrases numérotées. Repère au plus ${per} MOMENTS FORTS qui gagneraient à être illustrés : déclaration d'un dirigeant, événement précis, chiffre, document, personne, lieu. Pour chacun :
- "phrase" : numéro de la phrase ;
- "sujet" : 3 à 8 mots, en français, ce qu'il faut montrer ;
- "youtube" : 2 requêtes YouTube courtes (2 à 6 mots) pour trouver la VIDÉO SOURCE (discours, interview, conférence de presse, reportage) : une dans la langue d'origine de la personne ou du pays concerné, une en anglais ;
- "presse" : 2 requêtes de presse courtes (une en arabe si le sujet concerne le monde arabe, une en anglais) ;
- "photo" : 1 ou 2 requêtes Wikimedia Commons en anglais (nom de la personne, du lieu, de l'institution) ;
- "mots" : 6 à 12 mots-clés (noms propres, chiffres, mots rares) en arabe, en anglais ET en français, pour retrouver le passage exact dans la transcription d'une vidéo.
Réponds UNIQUEMENT en JSON : {"moments":[{"phrase":n,"sujet":"…","youtube":["…"],"presse":["…"],"photo":["…"],"mots":["…"]}]}`;
  const out = [];
  for (const b of bl) {
    const j = await askText(sys, b.map((s) => `${s.i} | ${s.text}`).join("\n"));
    for (const m of Array.isArray(j?.moments) ? j.moments : []) {
      const s = sents.find((x) => x.i === Math.round(Number(m?.phrase))) || b[0];
      const arr = (v, n) => (Array.isArray(v) ? v : [v]).map((x) => clean(x, 90)).filter(Boolean).slice(0, n);
      if (!clean(m?.sujet)) continue;
      out.push({ t: s.t0, phrase: clean(s.text, 160), sujet: clean(m.sujet, 90), youtube: arr(m.youtube, 2), presse: arr(m.presse, 2), photo: arr(m.photo, 2), mots: arr(m.mots, 14) });
    }
  }
  if (!out.length) {          // sans IA : les mots les plus porteurs de la voix (noms propres, mots longs répétés)
    const freq = new Map();
    for (const s of sents) for (const w of s.text.split(/\s+/)) { const k = w.replace(/[^\p{L}\p{N}]/gu, ""); if (k.length > 4) freq.set(k, (freq.get(k) || 0) + 1); }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w);
    if (top.length) out.push({ t: 0, phrase: clean(sents[0]?.text, 160), sujet: top.join(" "), youtube: [top.slice(0, 3).join(" ")], presse: [top.slice(0, 3).join(" ")], photo: [], mots: top, sansIA: true });
  }
  // dédoublonnage (même sujet) et ordre chronologique
  const seen = new Set();
  return out.filter((m) => { const k = m.sujet.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t).slice(0, MAX_MOMENTS);
}

// ---------------------------------------------------------------- 2) YouTube : vidéos + passage précis
const ytKeys = () => keysOf("YOUTUBE_API_KEYS", "YOUTUBE_API_KEY", "YOUTUBE_API_KEYS_PLUS", "YT_API_KEYS", "YT_API_KEY");
const isoDur = (d) => { const m = String(d || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
let ytDead = false;
async function ytApi(pathq) {
  for (const k of ytKeys()) {
    if (ytDead) return null;
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${pathq}&key=${k}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (r && r.ok) return r.json();
    if (r && r.status === 403) continue;                 // quota de la clé épuisé : clé suivante
  }
  ytDead = true;
  return null;
}
export async function youtube(m, lang) {
  if (!ytKeys().length) return [];
  const ids = new Map();
  for (const q of m.youtube) {
    const j = await ytApi(`search?part=snippet&type=video&maxResults=4&q=${encodeURIComponent(q)}&relevanceLanguage=${lang === "ar" ? "ar" : "en"}`);
    for (const it of j?.items || []) if (it.id?.videoId && !ids.has(it.id.videoId)) ids.set(it.id.videoId, { id: it.id.videoId, titre: clean(it.snippet?.title, 110), chaine: clean(it.snippet?.channelTitle, 60), date: String(it.snippet?.publishedAt || "").slice(0, 10) });
  }
  if (!ids.size) return [];
  const d = await ytApi(`videos?part=contentDetails,statistics,snippet&id=${[...ids.keys()].join(",")}`);
  for (const it of d?.items || []) { const v = ids.get(it.id); if (!v) continue; v.duree = isoDur(it.contentDetails?.duration); v.vues = Number(it.statistics?.viewCount || 0); v.description = String(it.snippet?.description || ""); }
  const list = [...ids.values()].filter((v) => !v.duree || v.duree >= 20).sort((a, b) => (b.vues || 0) - (a.vues || 0)).slice(0, 3);
  for (const v of list) v.passage = passage(v, m.mots);
  return list;
}
// passage précis : 1) sous-titres de la vidéo (script Python, si YouTube les donne) ; 2) chapitres de la description
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ًͯ-ٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي");
function passage(v, mots) {
  const keys = mots.map(norm).filter((w) => w.length > 2);
  try {
    const out = execFileSync("python3", [path.resolve("scripts/explainer/yt_passage.py"), v.id, JSON.stringify(keys)], { timeout: 45000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const j = JSON.parse(out);
    if (j && isFinite(j.start)) return { t0: j.start, t1: j.end, how: "sous-titres", extrait: clean(j.text, 140) };
  } catch { /* sous-titres indisponibles (bloqués, absents) : chapitres */ }
  const ch = [...String(v.description || "").matchAll(/(?:^|\n)\s*((?:\d+:)?\d{1,2}:\d{2})\s*[-–—:]?\s*(.+)/g)].map((x) => ({ t: x[1].split(":").reduce((a, b) => a * 60 + Number(b), 0), titre: x[2] }));
  let best = null;
  for (const [i, c] of ch.entries()) { const n = keys.filter((k) => norm(c.titre).includes(k)).length; if (n && (!best || n > best.n)) best = { n, t0: c.t, t1: ch[i + 1]?.t ?? c.t + 90, titre: c.titre }; }
  return best ? { t0: best.t0, t1: best.t1, how: "chapitre", extrait: clean(best.titre, 100) } : null;
}

// ---------------------------------------------------------------- 3) presse : Google News (gratuit, sans clé)
const decode = (s) => String(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
export async function presse(m, lang) {
  const out = [], seen = new Set();
  for (const q of m.presse) {
    const ar = /[؀-ۿ]/.test(q), L = ar ? LANG.ar : lang === "fr" ? LANG.fr : LANG.en;
    const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${L.hl}&gl=${L.gl}&ceid=${L.ceid}`);
    const xml = r ? await r.text() : "";
    for (const it of xml.split("<item>").slice(1, 4)) {
      const titre = decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""), lien = decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
      const media = decode((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || ""), date = new Date((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
      const k = titre.toLowerCase().slice(0, 60);
      if (!titre || !lien || seen.has(k)) continue; seen.add(k);
      out.push({ titre: clean(titre.replace(new RegExp(`\\s*-\\s*${media.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), ""), 140), media: clean(media, 50), date: isNaN(date) ? "" : date.toISOString().slice(0, 10), lien });
    }
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- 4) photos LIBRES DE DROITS (Wikimedia Commons) téléchargées
const LIBRE = /^(cc0|cc[- ]by(?:[- ]sa)?(?:[- ][\d.]+)?|public domain|pd[- ]|attribution|no restrictions)/i;
export async function photos(m, idx, dir, budget) {
  const out = [];
  for (const q of m.photo) {
    if (out.length >= 2 || budget.n <= 0) break;
    const r = await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch=${encodeURIComponent(q + " filetype:bitmap")}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1920`);
    const pages = Object.values((r ? await r.json().catch(() => ({})) : {}).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const p of pages) {
      if (out.length >= 2 || budget.n <= 0) break;
      const ii = p.imageinfo?.[0], md = ii?.extmetadata || {};
      const lic = clean(md.LicenseShortName?.value || "", 40);
      if (!ii || !LIBRE.test(lic) || (ii.width || 0) < 600) continue;
      const img = await get(ii.thumburl || ii.url, { timeout: 40000 });
      if (!img) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length < 15000) continue;
      const name = `${String(idx).padStart(2, "0")}-${m.sujet.normalize("NFD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "photo"}-${out.length + 1}.jpg`;
      writeFileSync(path.join(dir, name), buf);
      const auteur = clean(String(md.Artist?.value || "").replace(/<[^>]+>/g, ""), 80) || "auteur inconnu";
      out.push({ fichier: name, auteur, licence: lic, page: ii.descriptionurl || "" });
      budget.n--;
    }
  }
  return out;
}

// ---------------------------------------------------------------- fichier final
export function render(list, { lang, yt, duree }) {
  const L = [`DOWNLOAD SEARCH POUR MONTAGES — ce qui illustre ta voix (${mmss(duree)}), moment par moment`, ``,
    `Vidéos : ouvre le lien (il démarre au bon passage), fais un enregistrement d'écran du passage indiqué, puis dépose-le avec ta voix.`,
    `  Enregistrement BRUT du téléphone accepté : le workflow recadre sur le lecteur (barres, titre, commentaires retirés) et coupe le début et la fin hors vidéo.`,
    `Pour la faire écouter avec son son, dis « اسمعوا » / « خلينا نسمع » juste avant dans ta voix : le workflow choisit la bonne vidéo selon son contenu.`,
    `Photos libres de droits : déjà téléchargées dans la release « out-recherche » (crédits ci-dessous). Pour les monter : champ « photos » = out-recherche.`,
    `Photos et articles de presse : non téléchargés automatiquement (droits d'auteur). Dépose tes captures avec ta voix :`,
    `  la SOURCE est affichée sous chaque média (« المصدر : … ») — lue sur l'image, ou dans le nom du fichier (ex. « reuters-ministre.jpg »).`, ``];
  if (!yt) L.push(`⚠ Pas de clé YouTube dans ce dépôt : vidéos non cherchées. Ajoute le secret YOUTUBE_API_KEYS (la même clé que dans OSINT-teleprompter).`, ``);
  if (!list.length) L.push("Aucun moment fort trouvé (IA indisponible et voix trop courte).");
  list.forEach((m, k) => {
    L.push(`════════ ${k + 1}. [${mmss(m.t)} dans ta voix] ${m.sujet}${m.sansIA ? " (repéré sans IA)" : ""}`, `Tu dis : « ${m.phrase} »`, ``);
    if (m.videos?.length) {
      L.push(`▶ VIDÉOS`);
      for (const v of m.videos) {
        const p = v.passage;
        L.push(`- ${v.titre} — ${v.chaine}${v.date ? ` (${v.date})` : ""}${v.duree ? ` — ${mmss(v.duree)}` : ""}`,
          `  https://www.youtube.com/watch?v=${v.id}${p ? `&t=${Math.max(0, Math.floor(p.t0 - 2))}s` : ""}`,
          p ? `  ⏱ passage à filmer : ${mmss(p.t0)} → ${mmss(p.t1)} (trouvé dans ${p.how}${p.extrait ? ` : « ${p.extrait} »` : ""})` : `  ⏱ minutage non trouvé : cherche « ${m.mots.slice(0, 3).join(" / ")} » dans la vidéo`);
      }
      L.push(``);
    } else if (yt) L.push(`▶ VIDÉOS : rien trouvé sur YouTube pour « ${m.youtube.join(" / ")} »`, ``);
    if (m.articles?.length) { L.push(`📰 PRESSE`); for (const a of m.articles) L.push(`- ${a.titre} — ${a.media || "?"}${a.date ? ` (${a.date})` : ""}`, `  ${a.lien}`); L.push(``); }
    if (m.photos?.length) { L.push(`🖼 PHOTOS LIBRES (release out-recherche)`); for (const p of m.photos) L.push(`- ${p.fichier} — ${p.auteur} — ${p.licence} — ${p.page}`); L.push(``); }
  });
  const cred = list.flatMap((m) => m.photos || []);
  if (cred.length) L.push(`CRÉDITS PHOTOS (à coller dans la description YouTube) :`, ...new Set(cred.map((p) => `${p.auteur}, ${p.licence}, via Wikimedia Commons`)), ``);
  return L.join("\n");
}

async function main() {
  const IN = process.env.EXPLAINER_TRANSCRIPT || "content/transcript.json";
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(path.join(OUT, "photos"), { recursive: true });
  if (!existsSync(IN)) { writeFileSync(path.join(OUT, FILE), "Transcription absente : recherche impossible.\n"); return; }
  const tr = JSON.parse(readFileSync(IN, "utf8"));
  const lang = String(tr.lang || "ar").slice(0, 2);
  const sents = sentencesOf((tr.words || []).filter((w) => w && w.w));
  const T0 = Date.now(), LIMIT = Number(process.env.RESEARCH_BUDGET_S || 600) * 1000;
  const list = await moments(sents, lang);
  console.log(`Recherche : ${list.length} moment(s) fort(s) — ${list.map((m) => m.sujet).join(" | ")}`);
  const budget = { n: Number(process.env.RESEARCH_MAX_PHOTOS || 16) };
  for (const [k, m] of list.entries()) {
    if (Date.now() - T0 > LIMIT) { m.note = "temps écoulé"; continue; }
    m.videos = await youtube(m, lang).catch(() => []);
    m.articles = await presse(m, lang).catch(() => []);
    m.photos = await photos(m, k + 1, path.join(OUT, "photos"), budget).catch(() => []);
    console.log(`  ${k + 1}. ${m.sujet} : ${m.videos.length} vidéo(s) (${m.videos.filter((v) => v.passage).length} avec passage), ${m.articles.length} article(s), ${m.photos.length} photo(s)`);
  }
  writeFileSync(path.join(OUT, FILE), render(list, { lang, yt: ytKeys().length > 0, duree: Number(tr.duration) || 0 }) + "\n");
  console.log(`✔ ${path.join(OUT, FILE)}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => {
  console.error("⚠ recherche interrompue : " + e.message);
  try { mkdirSync(OUT, { recursive: true }); writeFileSync(path.join(OUT, FILE), `Recherche interrompue : ${e.message}\n`); } catch {}
});
