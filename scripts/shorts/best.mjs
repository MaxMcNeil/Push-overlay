// scripts/shorts/best.mjs — formule « BEST-OF » : DEUX shorts, chacun un enchaînement des moments LES PLUS INTENSES
// de toute la vidéo (choquants, controversés, révélations, chiffres, colère, ironie, punchlines).
//   short 01 « best-of »  : 45-55 s, 5 à 8 moments ;
//   short 02 « nerveux »  : 30-35 s, moments courts (≤ 8 s), autre ouverture et autre sommet que le 1er.
// Construction (pensée rétention) :
//   1. OUVERTURE CHOC : le moment le plus explosif en premier (aucune intro) ;
//   2. MONTÉE : les autres du fort au très fort ;
//   3. POINT CULMINANT à la fin (la punchline la plus forte) ; la fin se fond dans la 1re image (le short boucle).
// Sélection : 1 demande à l'IA (Gemini ENTEND l'audio : ton, colère, ironie) qui note des « moments » de 1 à 3
// phrases ; puis 1 demande de « rédacteur en chef » qui relit les deux montages, écarte ce qui ne se comprend pas seul,
// et écrit titre provocateur, description, hashtags et tags. Sans IA : intensité mesurée (volume, débit, ! ? chiffres).
// Coupes TOUJOURS entre deux phrases. Écrit shorts/selection.json (clips avec « segments »).
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { providers, parseJson } from "../lib/llm.mjs";
import { findVideo } from "../lib/util.mjs";

const ERRORS = [];
const DEADLINE = Date.now() + Number(process.env.SELECT_BUDGET_MIN || 14) * 60 * 1000;
const leftMs = () => DEADLINE - Date.now();
const tr = JSON.parse(readFileSync("content/transcript.json", "utf8"));
const lang = tr.lang || "fr";
const LANG_NAME = { fr: "français", ar: "arabe", en: "anglais", it: "italien" }[lang] || "français";
const DUR = tr.duration || tr.words.at(-1)?.t1 || 0;
const FOCUS = String(process.env.SHORTS_FOCUS || "").trim().slice(0, 400);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const ENDS = /[.!?؟…]["»”]?$/;
const MOM_MIN = 2.5, MOM_MAX = 15;
export const VARIANTS = [
  { id: "01", label: "best-of", lo: 45, hi: 55, target: 50, maxMoments: 8, momentMax: 12 },
  { id: "02", label: "nerveux", lo: 30, hi: 35, target: 32, maxMoments: 5, momentMax: 8 },
];

// ---------- phrases ----------
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ t0: cur[0].t0, t1: cur.at(-1).t1, text: cur.map((w) => w.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1"), n: cur.length });
    cur = [];
  };
  for (const w of words) {
    const gap = cur.length ? w.t0 - cur.at(-1).t1 : 0;
    if (cur.length && (gap > 1.0 || w.t1 - cur[0].t0 > 14)) flush();
    cur.push(w);
    if (ENDS.test(w.w) && cur.length >= 3) flush();
  }
  flush();
  return out.map((s, i) => ({ ...s, i }));
}
const S = sentencesOf(tr.words || []);
if (!S.length) { console.error("Aucune phrase dans la transcription."); process.exit(1); }
const textOf = (a, b) => S.slice(a, b + 1).map((s) => s.text).join(" ");

// ---------- intensité mesurée (sans IA, et pour départager) : volume + débit + ponctuation ----------
function loudness() {
  try {
    const v = findVideo();
    const buf = execFileSync("ffmpeg", ["-v", "error", "-i", v, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 30 });
    const x = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    return S.map((s) => {
      const a = Math.floor(s.t0 * 8000), b = Math.min(x.length, Math.ceil(s.t1 * 8000));
      let e = 0; for (let k = a; k < b; k++) e += (x[k] / 32768) ** 2;
      return 10 * Math.log10(e / Math.max(1, b - a) + 1e-12);
    });
  } catch { return S.map(() => 0); }
}
const LOUD = loudness();
const loudSorted = [...LOUD].sort((a, b) => a - b);
const pctOf = (v) => loudSorted.findIndex((x) => x >= v) / Math.max(1, loudSorted.length - 1);
function heurScore(a, b) {
  let sc = 0;
  for (let k = a; k <= b; k++) {
    const s = S[k];
    const rate = s.n / Math.max(0.5, s.t1 - s.t0);
    sc += pctOf(LOUD[k]) * 4 + Math.min(1.5, rate / 2.5) + (/!/.test(s.text) ? 1.2 : 0) + (/[?؟]/.test(s.text) ? 0.8 : 0) + (/\d/.test(s.text) ? 1 : 0);
  }
  return sc / (b - a + 1);
}

// ---------- IA : moments ----------
function audioPart() {
  try {
    const v = findVideo();
    if (!v || DUR > 40 * 60) return null;
    const out = "content/audio-select.mp3";
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", v, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "16k", out], { stdio: ["ignore", "ignore", "inherit"] });
    if (statSync(out).size > 13 * 1024 * 1024) return null;
    return { inlineData: { mimeType: "audio/mp3", data: readFileSync(out).toString("base64") } };
  } catch { return null; }
}
const lines = (arr) => arr.map((s) => `[${s.i}] ${fmt(s.t0)} (${Math.max(1, Math.round(s.t1 - s.t0))}s) ${s.text.slice(0, 400)}`).join("\n");
function momentsSys() {
  return [
    `Tu es le meilleur monteur de YouTube Shorts / TikTok du monde, spécialiste de la RÉTENTION. Tu écris en ${LANG_NAME}.`,
    "Tu reçois la transcription d'une vidéo longue en phrases numérotées : [numéro] horaire (durée) texte. Si l'AUDIO est joint, ÉCOUTE-LE : le ton, la colère, l'ironie, l'insistance comptent autant que les mots.",
    "Trouve les 16 à 22 MOMENTS LES PLUS INTENSES de toute la vidéo, pour en faire un best-of explosif : révélation, accusation, chiffre choquant, injustice, scandale, phrase-choc, prise de position tranchée, colère, ironie mordante, question qui dérange, moment controversé.",
    `Un MOMENT = 1 à 3 phrases CONSÉCUTIVES, de ${MOM_MIN} à ${MOM_MAX} secondes (additionne les durées), qui frappe SEUL : on comprend de qui/de quoi on parle sans le reste (pas de « il », « ça », « cette affaire » sans antécédent ; jamais « et / mais / donc » en tête).`,
    "Préfère les moments COURTS et denses (4 à 9 s). Pas de transitions, de répétitions, de « bonjour », de remerciements, de phrases molles.",
    "Pour chaque moment : intensite (1-10, sois exigeant : 9-10 = on arrête de scroller), ouverture (1-10 : ferait-il une PREMIÈRE seconde de short irrésistible ?), type (choc, chiffre, accusation, révélation, colère, ironie, punchline, question).",
    "N'invente rien. Toute accusation est celle du locuteur (le résumé dit « il accuse », « selon lui »).",
    FOCUS ? `Consigne de l'utilisateur : ${FOCUS}` : "",
    'Réponds UNIQUEMENT en JSON : {"moments":[{"start":<n° 1re phrase>,"end":<n° dernière phrase>,"intensite":0,"ouverture":0,"type":"...","resume":"8-15 mots"}]}',
  ].filter(Boolean).join("\n");
}
async function aiMoments(name, fn) {
  const audio = name === "gemini" ? audioPart() : null;
  let src = S;
  if (name === "groq" && lines(S).length / 3.2 > 7000) {   // offre gratuite Groq : texte limité → phrases les plus fortes
    const keep = new Set(S.map((s, k) => [heurScore(k, k), k]).sort((a, b) => b[0] - a[0]).slice(0, 220).map((x) => x[1]));
    src = S.filter((s) => keep.has(s.i) || keep.has(s.i - 1) || keep.has(s.i + 1));
  }
  console.log(`Moments les plus intenses via ${name}${audio ? " (texte + audio)" : ""} — ${src.length} phrases…`);
  const txt = await fn(momentsSys(), (audio ? "L'AUDIO est joint : écoute l'intensité.\n\n" : "") + lines(src),
    { audio, maxTokens: 16000, temperature: 0.35, timeoutMs: 150 * 1000, thinking: 4096, deadline: DEADLINE - 4 * 60 * 1000 });
  const j = parseJson(txt);
  if (!j?.moments?.length) throw new Error(`réponse illisible (${String(txt).replace(/\s+/g, " ").slice(0, 140)})`);
  return j.moments;
}
function toMoments(raw, src) {
  const out = [];
  for (const m of raw) {
    let a = Number(m.start), b = Number(m.end);
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    if (a > b) [a, b] = [b, a];
    a = Math.max(0, a); b = Math.min(S.length - 1, b);
    while (b > a && S[b].t1 - S[a].t0 > MOM_MAX) b--;                  // trop long : on finit plus tôt (fin de phrase)
    const d = S[b].t1 - S[a].t0;
    if (d < MOM_MIN || d > MOM_MAX) continue;
    if (/^(et|mais|donc|alors|du coup|parce|and|but|so|e|ma|quindi|و|ثم|لكن)\b/i.test(S[a].text)) continue;
    const ia = Math.max(0, Math.min(10, Number(m.intensite) || 0)), op = Math.max(0, Math.min(10, Number(m.ouverture) || 0));
    out.push({ a, b, t0: S[a].t0, t1: S[b].t1, d, intensity: src === "ia" ? ia + heurScore(a, b) * 0.15 : heurScore(a, b),
      opening: src === "ia" ? op : heurScore(a, a), type: str(m.type, 30), resume: str(m.resume, 140), src });
  }
  return out;
}
function heuristicMoments() {
  const out = [];
  for (let a = 0; a < S.length; a++) for (let b = a; b < Math.min(S.length, a + 3); b++) {
    const d = S[b].t1 - S[a].t0;
    if (d >= 3.5 && d <= 10 && ENDS.test(S[b].text)) out.push({ start: a, end: b });
  }
  return toMoments(out, "mesure").sort((x, y) => y.intensity - x.intensity).slice(0, 60);
}

// ---------- assemblage d'un short ----------
const ov = (x, y) => Math.min(x.t1, y.t1) - Math.max(x.t0, y.t0) > -1.0;     // se touchent ou se chevauchent
export function assemble(moms, V, avoid = []) {
  // 2e short : ses moments viennent de préférence d'AUTRES passages que le 1er (les deux shorts ne se répètent pas)
  const used = (m) => avoid.some((c) => ov(c, m));
  const val = (m) => m.intensity - (used(m) ? 1.5 : 0);
  const pool = moms.filter((m) => m.d <= V.momentMax + 0.5).sort((x, y) => val(y) - val(x));
  const chosen = [];
  let tot = 0;
  // ouverture : le meilleur moment d'ouverture parmi les plus intenses (court de préférence), jamais celle de l'autre short
  const opener = pool.filter((m) => !avoid.length || !ov(avoid[0], m)).slice(0, 10).sort((x, y) => (y.opening + y.intensity * 0.5 - y.d * 0.08) - (x.opening + x.intensity * 0.5 - x.d * 0.08))[0];
  if (opener) { chosen.push(opener); tot += opener.d; }
  for (const m of pool) {
    if (chosen.length >= V.maxMoments || tot >= V.target) break;
    if (chosen.some((c) => ov(c, m))) continue;
    if (tot + m.d > V.hi + 1) continue;
    chosen.push(m); tot += m.d;
  }
  if (tot < V.lo) {   // trop court : on complète avec les suivants, même un peu moins intenses
    for (const m of moms.slice().sort((x, y) => y.intensity - x.intensity)) {
      if (tot >= V.lo || chosen.length >= V.maxMoments + 2) break;
      if (chosen.some((c) => ov(c, m)) || tot + m.d > V.hi + 2) continue;
      chosen.push(m); tot += m.d;
    }
  }
  if (!chosen.length) return [];
  // ordre : ouverture, puis montée en intensité, le plus fort en dernier (point culminant)
  const [first, ...rest] = chosen;
  rest.sort((x, y) => x.intensity - y.intensity);
  // jamais le même sommet que l'autre short
  if (avoid.length > 1 && rest.length > 1 && ov(rest.at(-1), avoid.at(-1))) rest.unshift(...rest.splice(-1, 1));
  return [first, ...rest];
}

// ---------- rédacteur en chef : relit les montages, écarte ce qui ne tient pas seul, écrit titre/description/tags ----------
function editorSys() {
  return [
    `Tu es rédacteur en chef YouTube Shorts, obsédé par la rétention et le clic. Tu écris en ${LANG_NAME}.`,
    "Pour chaque short (une suite de moments numérotés, dans l'ordre de diffusion) :",
    "- vérifie que CHAQUE moment se comprend SEUL et frappe ; liste dans \"retirer\" les numéros des moments incompréhensibles, mous ou qui se répètent ;",
    "- titre : PROVOCATEUR et ORIGINAL, 40 à 70 caractères, fidèle à ce qui est dit (accusations attribuées : « il accuse… ») ;",
    "- hook : 3 à 6 mots en surimpression à la 1re seconde ; description : 1 à 2 phrases qui donnent envie de voir la vidéo complète ;",
    "- hashtags : 3 à 5 ; tags : 8 à 15 mots-clés de recherche (sans #).",
    'Réponds UNIQUEMENT en JSON : {"shorts":[{"id":"01","retirer":[],"title":"...","hook":"...","description":"...","hashtags":["#..."],"tags":["..."]}]}',
  ].join("\n");
}
async function editor(fn, shorts) {
  const user = shorts.map((s) => `=== short ${s.id} (${s.label}) ===\n` + s.moments.map((m, k) => `[${k + 1}] (${Math.round(m.d)} s) ${textOf(m.a, m.b).slice(0, 600)}`).join("\n")).join("\n\n");
  const j = parseJson(await fn(editorSys(), user, { maxTokens: 6000, temperature: 0.4, timeoutMs: 120 * 1000, thinking: 1024, deadline: DEADLINE }));
  const map = new Map();
  for (const s of j?.shorts || []) map.set(String(s.id).padStart(2, "0"), s);
  return map;
}

// ---------- main ----------
let moms = [], engine = "mesure", edFn = null;
for (const [name, fn] of providers()) {
  if (leftMs() < 90000) break;
  try {
    moms = toMoments(await aiMoments(name, fn), "ia");
    console.log(`  ${moms.length} moment(s) exploitables.`);
    if (moms.length >= 4) { engine = name; edFn = fn; break; }
    throw new Error("trop peu de moments exploitables");
  } catch (e) { console.log(`${name} : ${e.message} — essai suivant.`); ERRORS.push(`${name} : ${e.message}`.slice(0, 300)); }
}
if (engine === "mesure") { console.log("⚠ Aucune IA : moments choisis par l'intensité mesurée (volume, débit, ponctuation)."); moms = heuristicMoments(); }
if (!moms.length) { console.error("Aucun moment intense exploitable dans cette vidéo."); process.exit(1); }

let shorts = [];
for (const V of VARIANTS) {
  const m = assemble(moms, V, shorts[0]?.moments || []);
  if (m.length) shorts.push({ ...V, moments: m });
}
if (edFn && leftMs() > 45000) {
  try {
    const ed = await editor(edFn, shorts);
    shorts = shorts.map((s) => {
      const e = ed.get(s.id);
      if (!e) return s;
      const drop = new Set((Array.isArray(e.retirer) ? e.retirer : []).map(Number).filter((k) => k > 1));  // jamais l'ouverture
      let mm = s.moments.filter((_, k) => !drop.has(k + 1));
      if (drop.size) {   // on complète avec d'autres moments forts pour rester dans la durée
        const tot = () => mm.reduce((n, x) => n + x.d, 0);
        for (const x of moms.slice().sort((p, q) => q.intensity - p.intensity)) {
          if (tot() >= s.lo) break;
          if (mm.some((c) => ov(c, x)) || s.moments.includes(x) || x.d > s.momentMax + 0.5 || tot() + x.d > s.hi + 1) continue;
          mm.splice(mm.length - 1, 0, x);   // avant le point culminant
        }
        console.log(`  short ${s.id} : ${drop.size} moment(s) retiré(s) par le rédacteur en chef`);
      }
      return { ...s, moments: mm, title: str(e.title, 100), hook: str(e.hook, 60), description: str(e.description, 400),
        hashtags: (Array.isArray(e.hashtags) ? e.hashtags : []).map((h) => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).filter((h) => h.length > 2).slice(0, 5),
        tags: (Array.isArray(e.tags) ? e.tags : []).map((t) => str(String(t).replace(/^#+/, ""), 40)).filter(Boolean).slice(0, 15) };
    });
  } catch (e) { console.log(`rédacteur en chef indisponible (${e.message}) : montages gardés tels quels.`); ERRORS.push(`rédacteur : ${e.message}`.slice(0, 300)); }
}

// bornes de coupe : petite marge sans jamais mordre sur le mot voisin
const W_ = tr.words || [];
function cutBounds(t0, t1) {
  const prev = [...W_].reverse().find((w) => w.t1 <= t0 + 0.01 && w.t0 < t0 - 0.01);
  const next = W_.find((w) => w.t0 >= t1 - 0.01 && w.t1 > t1 + 0.01);
  const start = Math.max(0, t0 - 0.12, prev ? prev.t1 + 0.04 : 0);
  let end = Math.min(DUR, t1 + 0.3);
  if (next) end = Math.min(end, Math.max(t1 + 0.04, next.t0 - 0.08));
  return { start: +Math.min(start, t0).toFixed(3), end: +Math.max(end, t1).toFixed(3) };
}
const clips = shorts.filter((s) => s.moments.length).map((s) => {
  const segments = s.moments.map((m) => ({ ...cutBounds(m.t0, m.t1), type: m.type, resume: m.resume, intensity: +m.intensity.toFixed(1), text: textOf(m.a, m.b).slice(0, 600) }));
  const duration = +segments.reduce((n, g) => n + g.end - g.start, 0).toFixed(2);
  return { id: s.id, label: s.label, formule: "best", loop: true, segments, start: segments[0].start, end: segments[0].end, duration,
    title: s.title || "", hook: s.hook || "", description: s.description || "", hashtags: s.hashtags || [], tags: s.tags || [],
    why: `best-of ${s.label} : ${segments.length} moments, ouverture choc puis montée`, score: Math.round(10 * s.moments[0].intensity),
    source: engine === "mesure" ? "mesure" : "ia", text: segments.map((g) => g.text).join(" … ").slice(0, 3000) };
});
mkdirSync("shorts", { recursive: true });
writeFileSync("shorts/selection.json", JSON.stringify({ lang, source_duration: DUR, engine, formule: "best", errors: ERRORS, clips }, null, 2));
console.log(`Best-of (${engine}) :`);
for (const c of clips) {
  console.log(`  #${c.id} ${c.label} — ${c.duration.toFixed(0)} s, ${c.segments.length} moments — « ${c.title || c.hook || "(sans titre)"} »`);
  c.segments.forEach((g, k) => console.log(`      ${k === 0 ? "OUVERTURE" : k === c.segments.length - 1 ? "SOMMET   " : "         "} ${fmt(g.start)} (${(g.end - g.start).toFixed(1)} s) [${g.intensity}] ${g.type} — « ${g.text.slice(0, 110)} »`));
}
