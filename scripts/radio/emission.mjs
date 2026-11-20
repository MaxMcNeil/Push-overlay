// scripts/radio/emission.mjs — « Émission radio » : tes audios (TikTok, Shorts…) deviennent des AUDITEURS AU BOUT DU FIL,
// toi l'ANIMATEUR. Deux étapes, un seul workflow (.github/workflows/emission-radio.yml) :
//   1) node emission.mjs analyse  : transcrit chaque audio, l'IA écrit TES phrases (accueil, présentation de chaque appel,
//      relances, questions, remarques, transitions entre sujets, clôture) → output/radio/emission-a-lire.txt + plan.json
//   2) node emission.mjs montage  : transcrit TA voix (toutes les phrases lues d'affilée), retrouve chaque phrase toute
//      seule, et monte l'émission : jingle, toi, sonnerie + décroché, l'auditeur « au téléphone », tes relances… → MP3.
// Entrées : input/radio/clips/NN-nom.ext (ordre = ordre de dépôt), input/radio/voix.* (étape 2), input/radio/plan.json (étape 2).
// Tous les sons d'habillage sont SYNTHÉTISÉS ici (aucun fichier, aucun droit), volume bas, jamais d'aigus.
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { providers, parseJson } from "../lib/llm.mjs";
import { transcribeAll } from "../transcribe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN = "input/radio", OUT = "output/radio", TMP = "output/radio/tmp";
const SR = 48000;
const LANGS = { fr: "français", ar: "arabe", en: "anglais", it: "italien", es: "espagnol", de: "allemand" };
const NOM_DEFAUT = { fr: "Le Journal du NON", ar: "Gulf think-tank" };

const sh = (args, opt = {}) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26, ...opt });
export function duree(f) {
  try { return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()) || 0; } catch { return 0; }
}
const r2 = (x) => Math.round(x * 100) / 100;

// essais hors ligne : RADIO_FAUX_ASR = fichier JSON { "nom de fichier": { lang, words:[{t0,t1,w}] } } (jamais en production)
async function transcrire(f, d) {
  if (process.env.RADIO_FAUX_ASR) {
    const j = JSON.parse(readFileSync(process.env.RADIO_FAUX_ASR, "utf8"))[path.basename(f)];
    if (j) return j;
  }
  return transcribeAll(f, d);
}

// Voix SANS la musique de fond (séparée par scripts/radio/sans_musique.sh) si elle existe, sinon l'audio d'origine
function source(fichier) {
  const b = path.join(IN, "voix-seules", fichier.replace(/\.[^.]+$/, ""));
  for (const ext of [".wav", ".opus"]) if (existsSync(b + ext)) return b + ext;
  return path.join(IN, "clips", fichier);
}

// ------------------------------------------------------------------ phrases d'un extrait (découpage aux fins de phrase)
export function phrases(words) {
  const out = [];
  let cur = [];
  const push = () => { if (cur.length) out.push({ i0: cur[0], i1: cur[cur.length - 1] }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    if (cur.length && words[i].t0 - words[i - 1].t1 > 0.9) push();     // longue pause = fin de phrase
    cur.push(i);
    if (/[.!?…؟]["»”']?$/.test(words[i].w) || cur.length >= 32) push();
  }
  push();
  return out.map((p) => ({ ...p, t0: words[p.i0].t0, t1: words[p.i1].t1, texte: words.slice(p.i0, p.i1 + 1).map((w) => w.w).join(" ") }));
}

// ------------------------------------------------------------------ normalisation (alignement texte ↔ transcription)
export function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")                     // arabe : voyelles brèves, tatouil
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’'`-]/g, " ").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
}
function lcs(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0), cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Retrouve chaque phrase (dans l'ordre) dans la transcription de ta voix. Une phrase RELUE (prise ratée puis refaite) :
 *  la DERNIÈRE prise avant la phrase suivante est gardée. Phrase introuvable → null (signalée, jamais inventée). */
export function aligner(lignes, words) {
  // jetons (un mot comme « l'antenne » donne 2 jetons), chacun relié à son mot horodaté
  const J = [];
  words.forEach((w, wi) => { const n = norm(w.w); (n.length ? n : ["∅"]).forEach((t) => J.push({ t, wi })); });
  const T = J.map((x) => x.t);
  const L = lignes.map((l) => norm(l));
  // fenêtres où la phrase li est lue (score ≥ seuil), maxima locaux. Recherche BORNÉE après la position courante (une voix
  // d'une heure = des milliers de mots) ; élargie seulement si rien n'est trouvé (phrase sautée, long bavardage).
  const cands = (li, from) => {
    for (const lim of [700, 3000, Infinity]) {
      const r = cands0(li, from, Math.min(T.length, from + lim));
      if (r.length || from + lim >= T.length) return r;
    }
    return [];
  };
  const cands0 = (li, from, fin) => {
    const toks = L[li], n = toks.length, res = [];
    if (!n) return res;
    const seuil = n <= 6 ? 0.72 : 0.6;
    for (let p = from; p < fin; p++) {
      if (!toks.slice(0, 4).some((t) => T[p] === t) && !toks.includes(T[p])) continue;   // doit commencer sur un mot de la phrase
      let best = null;
      for (const k of [Math.round(n * 0.8), n, Math.round(n * 1.25)]) {
        if (k < 1 || p + k > T.length) continue;
        const sc = lcs(toks, T.slice(p, p + k)) / Math.max(n, k);
        if (!best || sc > best.sc) best = { p, e: p + k - 1, sc };
      }
      if (best && best.sc >= seuil) {
        const last = res[res.length - 1];
        if (last && best.p <= last.e) { if (best.sc > last.sc) res[res.length - 1] = best; }   // même lecture : la meilleure fenêtre
        else res.push(best);
      }
    }
    return res;
  };
  const out = [];
  let cursor = 0;
  for (let li = 0; li < L.length; li++) {
    const c = cands(li, cursor);
    if (!c.length) { out.push(null); continue; }
    // borne : première lecture de la phrase SUIVANTE trouvée après la première prise de celle-ci
    let borne = Infinity;
    for (let nj = li + 1; nj < Math.min(L.length, li + 3); nj++) {
      const cn = cands(nj, c[0].e + 1);
      if (cn.length) { borne = cn[0].p; break; }
    }
    const prises = c.filter((x) => x.p < borne);
    const pick = prises[prises.length - 1] || c[0];
    // ajuste les bords : retire les mots en trop au début/à la fin s'ils ne sont pas dans la phrase
    let p = pick.p, e = pick.e;
    while (e > p && !L[li].includes(T[e])) e--;
    while (p < e && !L[li].includes(T[p])) p++;
    const w0 = J[p].wi, w1 = J[e].wi;
    out.push({ i0: w0, i1: w1, t0: words[w0].t0, t1: words[w1].t1, score: r2(pick.sc), prises: prises.length,
      avant: w0 > 0 ? words[w0 - 1].t1 : 0, apres: w1 + 1 < words.length ? words[w1 + 1].t0 : Infinity });
    cursor = e + 1;
  }
  return out;
}

/** Tu n'as pas lu mot pour mot (dialecte, autres mots…) : peu importe. Les phrases RECONNUES servent de repères ; chaque phrase
 *  non reconnue reçoit, DANS L'ORDRE, le passage de ta voix situé entre les deux repères qui l'entourent, découpé aux pauses
 *  selon la longueur prévue de chaque phrase. Rien de ce que tu as enregistré n'est perdu, aucune phrase n'est sautée. */
export function placerParPosition(lignes, words, al) {
  const out = al.slice();
  const fin = (k) => (k >= 0 ? out[k].i1 : -1);
  let k = 0;
  while (k < out.length) {
    if (out[k]) { k++; continue; }
    let m = k;
    while (m + 1 < out.length && !out[m + 1]) m++;
    const prev = k - 1, next = m + 1 < out.length ? m + 1 : -1;
    const w0 = fin(prev) + 1, w1 = next >= 0 ? out[next].i0 - 1 : words.length - 1;
    const n = m - k + 1;
    if (w1 - w0 + 1 >= n) {
      // découpe proportionnelle à la longueur prévue, recalée sur la plus longue pause voisine
      const poids = lignes.slice(k, m + 1).map((l) => Math.max(1, norm(l).length));
      const total = poids.reduce((a, b) => a + b, 0), nb = w1 - w0 + 1;
      const coupes = [];
      let cum = 0;
      for (let j = 0; j < n - 1; j++) {
        cum += poids[j];
        const cible = w0 + Math.round((nb * cum) / total) - 1;
        const lo = Math.max((coupes[j - 1] ?? w0 - 1) + 1, cible - Math.max(3, Math.round(nb / n / 2)));
        const hi = Math.min(w1 - (n - 1 - j), cible + Math.max(3, Math.round(nb / n / 2)));
        let best = Math.max(lo, Math.min(hi, cible)), bg = -1;
        for (let q = lo; q <= hi; q++) { const g = words[q + 1] ? words[q + 1].t0 - words[q].t1 : 0; if (g > bg) { bg = g; best = q; } }
        coupes.push(best);
      }
      let a0 = w0;
      for (let j = 0; j < n; j++) {
        const b0 = j < n - 1 ? coupes[j] : w1;
        out[k + j] = { i0: a0, i1: b0, t0: words[a0].t0, t1: words[b0].t1, score: 0, prises: 1, position: true,
          avant: a0 > 0 ? words[a0 - 1].t1 : 0, apres: b0 + 1 < words.length ? words[b0 + 1].t0 : Infinity };
        a0 = b0 + 1;
      }
    }
    k = m + 1;
  }
  return out;
}

// ------------------------------------------------------------------ SALUTATIONS : jamais à l'antenne (ni toi, ni les auditeurs)
const SALUT = new Set(norm("bonjour bonsoir salut coucou hello hi hey salam salamalaykoum salamalekoum slm ciao buongiorno buonasera salve hola " +
  "هلا مرحبا اهلا السلام سلام مساء صباح مساكم صباحكم يسعد").join(" ").split(" "));
const SUITE = new Set(norm("a à tous toutes tout monde amis mes chers chères mesdames messieurs et bienvenue everyone everybody all guys folks " +
  "there a tutti amici alaykoum aleykoum alikoum alaikum wa rahmatullah wabarakatuh عليكم عليكم ورحمه ورحمة الله وبركاته يسعد مساكم الخير بالخير " +
  "بكل خير النور جميعا يا جماعه شباب اخواني اخوتي الكرام ومرحبا واهلا بكم فيكم").join(" ").split(" "));
// arabe : mots ENTIERS (\b ne marche pas pour l'arabe) — « اهلا » ne doit pas se déclencher dans « متجاهلاً »
const AR = (mots) => new RegExp(`(^|[\\s،؛.؟!«»"'(])(${mots})(?=$|[\\s،؛.؟!«»"')ًٌٍ])`);
const SALUT_LAT = /\b(bonjour|bonsoir|salut|coucou|hello|good (evening|morning|afternoon)|buonasera|buongiorno|ciao|salam)\b/i;
const SALUT_AR = AR("السلام عليكم|سلام عليكم|مساء الخير|صباح الخير|مرحبا|مرحباً|أهلا|أهلاً|اهلا|اهلاً|يسعد مساكم|مساكم الله");
export const SALUT_ANIM = { test: (t) => SALUT_LAT.test(t) || SALUT_AR.test(t) };
/** Index du premier mot APRÈS une salutation d'ouverture (« Salam aleykoum à tous… », « Bonsoir tout le monde… »). */
export function apresSalut(mots, i0, i1) {
  const tok = (k) => (k <= i1 ? norm(mots[k][2]) : []);
  const ok = (k) => { const t = tok(k); return t.length > 0 && t.every((x) => SALUT.has(x) || SUITE.has(x)); };
  // une salutation dans les 2 premiers mots (« Bonsoir… », « الله يسعد مساكم… »), et rien d'autre avant elle
  const debut = [i0, i0 + 1].find((k) => tok(k).some((t) => SALUT.has(t)));
  if (debut === undefined || (debut > i0 && !ok(i0))) return i0;
  let k = i0;
  while (k <= i1 && k - i0 < 14) {
    if (ok(k)) { k++; continue; }
    const t = tok(k);       // « tout le monde », « les amis » : « le/les » seulement devant « monde/amis »
    if (t.length === 1 && ["le", "les"].includes(t[0]) && tok(k + 1).some((x) => x === "monde" || x === "amis")) { k++; continue; }
    break;
  }
  return k;
}

// ------------------------------------------------------------------ IA (patiente : une IA surchargée est réessayée, jamais abandonnée trop tôt)
const T0 = Date.now();
const BUDGET = Number(process.env.RADIO_BUDGET_MIN || 100) * 60 * 1000;      // temps max pour toute l'écriture
const reste = () => BUDGET - (Date.now() - T0);
const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));
async function ia(sys, user, { tours = 4, maxTokens = 8000 } = {}) {
  const prov = providers();
  if (!prov.length) throw new Error("aucune clé IA (GEMINI_API_KEY / GROQ_API_KEY) : impossible d'écrire tes phrases");
  let last = null;
  for (let k = 0; k < tours; k++) {
    if (k) {                                   // tout le monde a échoué : surcharge passagère → on patiente puis on réessaie
      const w = [0, 45, 90, 180, 240][k] || 240;
      if (reste() < (w + 120) * 1000) break;
      console.log(`  IA indisponible pour l'instant : nouvel essai dans ${w} s`);
      await dormir(w);
    }
    for (const [nom, fn] of prov) {
      if (reste() < 90 * 1000) break;
      try {
        const raw = await fn(sys, user, { json: true, temperature: 0.75, maxTokens, deadline: Date.now() + Math.min(7 * 60 * 1000, reste() - 60 * 1000) });
        const j = parseJson(raw);
        if (j) return { j, nom };
        last = new Error(`${nom} : réponse illisible`);
      } catch (e) { last = e; console.log(`  ${nom} : ${String(e.message).slice(0, 160)}`); }
    }
  }
  throw last || new Error("IA indisponible");
}

const NOUS = { fr: /\b(nous|notre|nos)\b/i, it: /\b(noi|nostro|nostra|nostri|nostre)\b/i, en: /\b(we|our|ours)\b/i,
  // arabe : « nous » et ses formes courantes à l'antenne (معنا، ننتقل، تابعونا…) — l'animateur reste HORS DU CONTEXTE
  // verbes à la 1re personne du pluriel, avec ou sans « و / ف / ل » collés devant (ولننتقل، فلنستمع، نترك…)
  ar: AR("(?:و|ف)?(?:ل)?(?:ننتقل|نستمع|نتابع|نرحب|نذهب|نعود|نستقبل|نسمع|نناقش|نتحدث|نترك|نبدأ|نختم|نفتح|نطرح|نرى|نتوقف|نكمل|نواصل|نعرض|نسأل)|" +
    "نحن|معنا|لنا|عندنا|بلادنا|وطننا|شعبنا|حلقتنا|برنامجنا|سمعنا|سمعناه|رأينا|قلنا|شاهدنا|شاركونا|تابعونا|راسلونا|اتصلوا بنا|ابقوا معنا|معاً|معا") };

/** La phrase est-elle bien dans la langue de l'émission ? (arabe : au moins 60 % de lettres arabes ; sinon : presque aucune) */
export function langueOk(t, lang) {
  const l = (String(t).match(/\p{L}/gu) || []).length;
  if (!l) return false;
  const ar = (String(t).match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length / l;
  return lang === "ar" ? ar >= 0.6 : ar < 0.2;
}

/** Vérifie et répare le déroulé proposé par l'IA pour un bloc d'auditeurs. { deroule, erreurs[] }. */
export function valider(j, clips, lang = "fr") {
  const erreurs = [];
  const d = Array.isArray(j?.deroule) ? j.deroule : [];
  const out = [];
  const vus = new Map();          // extrait -> dernière phrase utilisée
  for (const it of d) {
    if (!it || typeof it !== "object") continue;
    const type = String(it.type || "").toLowerCase();
    if (type.startsWith("anim")) {
      const t = String(it.texte || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      const defauts = [];
      if (NOUS[lang]?.test(t)) defauts.push("nous");
      if (SALUT_ANIM.test(t)) defauts.push("salutation");
      if (!langueOk(t, lang)) defauts.push("langue");
      if (t.split(" ").length < 5) { erreurs.push(`phrase trop courte pour être reconnue (5 mots minimum) : « ${t} »`); continue; }
      defauts.forEach((x) => erreurs.push(`${x === "nous" ? "« nous » interdit" : x === "langue" ? `phrase pas en ${LANGS[lang]}` : "salutation interdite"} : « ${t.slice(0, 60)} »`));
      let mode = String(it.mode || "normal").toLowerCase();
      mode = mode.startsWith("coup") ? "coupe" : mode.startsWith("sil") ? "silence" : "normal";
      // couper la parole / profiter d'un silence : seulement AU MILIEU d'un appel (l'auditeur était en train de parler)
      if (mode !== "normal" && out[out.length - 1]?.type !== "appel") mode = "normal";
      out.push({ type: "animateur", role: String(it.role || "relance"), mode, ton: String(it.ton || "").replace(/\s+/g, " ").trim().slice(0, 60), texte: t, ...(defauts.length ? { defauts } : {}) });
    } else if (type.startsWith("appel") || type.startsWith("extrait")) {
      const e = Number(it.extrait) - 1, c = clips[e];
      if (!c) { erreurs.push(`extrait ${it.extrait} inexistant`); continue; }
      let [a, b] = Array.isArray(it.phrases) ? it.phrases.map(Number) : [0, c.phrases.length - 1];
      if (!isFinite(a)) a = 0;
      if (!isFinite(b)) b = c.phrases.length - 1;
      a = Math.max(0, Math.min(a, c.phrases.length - 1)); b = Math.max(a, Math.min(b, c.phrases.length - 1));
      const dern = vus.has(e) ? vus.get(e) : -1;
      if (a <= dern) { if (b <= dern) { erreurs.push(`extrait ${e + 1} : passage répété`); continue; } a = dern + 1; }
      vus.set(e, b);
      out.push({ type: "appel", extrait: e + 1, phrases: [a, b], nouvel_appel: !!it.nouvel_appel || !out.some((x) => x.type === "appel" && x.extrait === e + 1) });
    }
  }
  const manquants = clips.map((_, i) => i).filter((i) => !vus.has(i));
  if (manquants.length) erreurs.push(`extrait(s) jamais diffusé(s) : ${manquants.map((i) => i + 1).join(", ")}`);
  if (!out.length || out[0].type !== "animateur") erreurs.push("le bloc doit commencer par l'animateur");
  if (!out.length || out[out.length - 1].type !== "animateur") erreurs.push("le bloc doit finir par l'animateur");
  for (let k = 1; k < out.length; k++) {
    if (out[k].type === "appel" && out[k].nouvel_appel && out[k - 1].type !== "animateur") erreurs.push(`appel de l'extrait ${out[k].extrait} lancé sans présentation`);
  }
  return { deroule: out, erreurs };
}

/** Répare ce qui reste après les essais, sans jamais bloquer l'émission : phrases avec « nous » / salutation → réécrites
 *  par l'IA (petite demande, n'importe quelle IA), sinon retirées ; auditeurs oubliés → ajoutés (avec leur sonnerie). */
async function reparer(deroule, clips, lang) {
  // par paquets de 12 (une petite demande passe partout), deux passages : ce qui résiste au 1er est retenté
  for (let passe = 0; passe < 2; passe++) {
    const fautives = deroule.filter((x) => x.type === "animateur" && x.defauts?.length);
    for (let k = 0; k < fautives.length; k += 12) {
      const lot = fautives.slice(k, k + 12);
      try {
        const { j } = await ia("Tu corriges des phrases d'animateur radio. Réponds en JSON valide.",
          `Réécris chaque phrase EN ${LANGS[lang].toUpperCase()} (traduis-la si elle est dans une autre langue ; une phrase marquée (DÉJÀ DITE)
doit être reformulée autrement) en gardant le sens, le ton et la longueur, SANS aucune salutation (bonjour, bonsoir, salut,
salam, مساء الخير, السلام عليكم, مرحبا…) et SANS « nous / notre / nos » ni leur équivalent (arabe : نحن، معنا، لنا، ننتقل، نستمع، شاركونا، تابعونا، ابقوا معنا…) : dis « la France »,
« les Français », « vous », « je », « l'auditeur » (arabe : أنا، أنتم، المستمع).
Réponds : {"phrases": ["…", "…"]} (même nombre, même ordre).
${lot.map((x, i) => `${i + 1}. ${x.defauts.includes("repetee") ? "(DÉJÀ DITE) " : ""}${x.texte}`).join("\n")}`, { tours: 3, maxTokens: 3000 });
        (Array.isArray(j.phrases) ? j.phrases : []).forEach((t, i) => {
          const x = lot[i], n = String(t || "").replace(/\s+/g, " ").trim();
          if (x && n.split(" ").length >= 5 && !SALUT_ANIM.test(n) && !NOUS[lang]?.test(n) && langueOk(n, lang) && n !== x.texte) { x.texte = n; delete x.defauts; }
        });
      } catch (e) { console.log(`  réécriture des phrases fautives impossible (${String(e.message).slice(0, 100)})`); }
    }
  }
  let out = deroule.filter((x) => !(x.type === "animateur" && x.defauts?.length));
  const retirees = deroule.length - out.length;
  if (retirees) console.log(`  ${retirees} phrase(s) avec salutation, « nous », mauvaise langue ou répétition retirée(s) (non corrigeables)`);
  out.forEach((x) => delete x.defauts);
  const vus = new Set(out.filter((x) => x.type === "appel").map((x) => x.extrait));
  clips.forEach((c, i) => { if (!vus.has(i + 1)) { out.push({ type: "appel", extrait: i + 1, phrases: [0, c.phrases.length - 1], nouvel_appel: true }); console.log(`  auditeur oublié par l'IA ajouté : ${c.fichier}`); } });
  return out;
}

// ------------------------------------------------------------------ TRANSCRIPTION (machines de préparation)
async function transcrireFichiers(fichiers) {
  mkdirSync(path.join(IN, "transcripts"), { recursive: true });
  let echecs = 0;
  for (const f of fichiers) {
    const p = source(f), d = duree(p);
    if (d < 1) { console.log(`  ${f} : illisible ou vide`); continue; }
    console.log(`Transcription de ${f} (${d.toFixed(0)} s)…`);
    try {
      const r = await transcrire(p, d);
      writeFileSync(path.join(IN, "transcripts", f + ".json"), JSON.stringify({ lang: r.lang, duree: r2(d), words: r.words }));
    } catch (e) { echecs++; console.log(`::warning::${f} : transcription impossible (${String(e.message).slice(0, 120)})`); }
  }
  if (echecs) throw new Error(`${echecs} audio(s) non transcrit(s)`);
}

// ------------------------------------------------------------------ ÉTAPE 1 : analyse → tes phrases à lire
const BLOC_CAR = Number(process.env.RADIO_BLOC_CAR || 4500);    // taille d'un bloc envoyé à l'IA : petit, pour que même l'offre gratuite de Groq l'accepte
export function blocs(clips) {
  const out = [];
  let cur = [], n = 0;
  for (const c of clips) {
    const t = c.phrases.reduce((s, p) => s + p.texte.length + 8, 0);
    if (cur.length && (n + t > BLOC_CAR || cur.length >= 6)) { out.push(cur); cur = []; n = 0; }
    cur.push(c); n += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

const REGLES = (lang, nom) => `LANGUE : TOUTES les phrases de l'animateur sont en ${LANGS[lang].toUpperCase()}${lang === "ar" ? " (arabe du Golfe compréhensible par tous, comme les auditeurs)" : ""}, sans exception.
Les exemples entre guillemets ci-dessous sont en français pour t'expliquer : ne les recopie JAMAIS, écris tes propres phrases en ${LANGS[lang]}.
RÈGLES DE L'ÉMISSION — l'animateur (l'utilisateur, qui lira tes phrases à voix haute) :
- présente CHAQUE nouvel appel avant de le diffuser (« Un auditeur en ligne… vous êtes à l'antenne, je vous écoute. »), jamais deux fois
  la même formule ;
- découpe les appels longs (plus de 25 s) en morceaux de 15 à 40 s environ et intervient entre eux de DEUX façons, en les variant :
  « coupe » = il COUPE LA PAROLE à l'auditeur (qui parle encore) : 5 à 12 mots, réflexe, vif (« Attendez, attendez… vous êtes en train
  de dire que… ? »), puis l'auditeur enchaîne ; « silence » = il profite d'une pause de l'auditeur pour glisser une question précise,
  une objection ou une remarque ironique. Dans les deux cas, la phrase rebondit EXACTEMENT sur ce que l'auditeur vient de dire et amène
  ce qu'il dit ensuite (le morceau suivant doit y répondre de façon crédible) ;
- peut écarter des phrases sans intérêt (bégaiements, hors-sujet, musique), sans jamais changer l'ordre d'un extrait ;
- réagit après chaque appel (analyse, contradiction, humour noir, chiffre ou fait SEULEMENT s'il est dit dans les extraits), remercie
  l'auditeur, puis fait la TRANSITION vers l'appel suivant : même sujet → « un autre auditeur n'est pas d'accord… » ; sujet différent →
  vraie transition de radio ; de temps en temps, une vraie QUESTION OUVERTE au public sur le sujet (jamais « likez », « partagez »,
  « abonnez-vous », ni « écrivez 1 si… / tapez X si… ») ; jamais d'heure ni de date.
ÉCRITURE DE SCÉNARISTE RADIO EXPERT : promesses et teasers avant les appels ; reformulation choc de ce que vient de dire l'auditeur ;
contradiction et avocat du diable ; punchline d'humour noir après les moments forts ; rythme varié ; chaque appel a sa propre couleur
(colère, témoignage, expert du quotidien, contradicteur) d'après ce qu'il dit ; tension qui monte. Pour CHAQUE phrase, le TON de
lecture en 2 à 4 mots, écrit lui aussi en ${LANGS[lang]} (en français par exemple : « sec, indigné », « ironique », « complice »,
« grave, lent », « faussement naïf »).
AUCUNE SALUTATION, nulle part : jamais « bonjour », « bonsoir », « salut », « salam aleykoum », « مساء الخير », « السلام عليكم », « مرحبا ».
Ne diffuse pas les phrases de salutation des auditeurs (« Salam aleykoum », « Bonsoir à tous »…) : commence leurs morceaux après.
STYLE : oral, vivant, phrases courtes, provocateur mais crédible ; vouvoiement. HORS DU CONTEXTE : jamais « nous », « notre », « nos »
(ni leur équivalent dans la langue de l'émission ; en arabe : jamais « نحن، معنا، لنا، ننتقل، نستمع، شاركونا، تابعونا، ابقوا معنا »…,
utilise « أنا » / la 1re personne du singulier, « أنتم » et le nom du pays) : « la France », « les Français », « vous », « je », « l'auditeur ». N'invente AUCUN
fait, aucun prénom, aucune ville d'auditeur ; ne dis jamais que ce sont des vidéos ou TikTok : ce sont des auditeurs au téléphone.
Chaque phrase de l'animateur fait AU MOINS 8 mots (5 pour une « coupe ») pour être reconnue quand il la lira, et au plus 70 mots.
Émission${nom ? ` « ${nom} »` : ""}. Tous les extraits du bloc sont diffusés, dans l'ordre donné.
FORMAT JSON :
{"titre": "titre accrocheur de l'émission",
 "deroule": [
  {"type": "animateur", "role": "presentation", "ton": "…", "texte": "…"},
  {"type": "appel", "extrait": 1, "phrases": [0, 4], "nouvel_appel": true},
  {"type": "animateur", "role": "relance", "mode": "coupe", "ton": "sec, incrédule", "texte": "…"},
  {"type": "appel", "extrait": 1, "phrases": [5, 9], "nouvel_appel": false},
  {"type": "animateur", "role": "relance", "mode": "silence", "ton": "faussement naïf", "texte": "…"},
  {"type": "appel", "extrait": 1, "phrases": [10, 14], "nouvel_appel": false},
  {"type": "animateur", "role": "reaction", "ton": "…", "texte": "…"}, …]}
("extrait" = numéro de l'extrait DANS CE BLOC ; "phrases": [première, dernière] = numéros [i] des phrases diffusées dans ce morceau.)`;

async function ecrireBloc(b, ctx, profondeur = 0) {
  const { lang, nom, sommaire, premier, dernier, avant, ouverture } = ctx;
  const total = b.reduce((s, c) => s + c.duree, 0);
  const mots = Math.round(Math.max(60, Math.min(900, total / 60 * 55)));
  const listing = b.map((c, k) => `EXTRAIT ${k + 1} — ${c.duree.toFixed(0)} s :\n` + c.phrases.map((p, i) => `  [${i}] ${p.texte}`).join("\n")).join("\n\n");
  const place = [
    premier ? `CE BLOC OUVRE L'ÉMISSION : commence par une ouverture qui accroche dès la première phrase (sujets du jour, standard ouvert)${ouverture ? `, juste après l'ouverture enregistrée qu'on vient d'entendre : « ${ouverture} »` : ""}.`
      : `CE BLOC CONTINUE L'ÉMISSION (pas de nouvelle ouverture). Juste avant, l'animateur disait : « ${avant || "…"} ». Commence par une transition vers le premier appel de ce bloc.`,
    dernier ? "CE BLOC TERMINE L'ÉMISSION : après le dernier appel, conclus (synthèse percutante, question ouverte au public), sans formule de salutation ni appel à liker ou partager."
      : "Ne conclus PAS l'émission : termine par ta réaction au dernier appel du bloc (un teaser « restez à l'écoute » est possible).",
  ].join("\n");
  const user = `${REGLES(lang, nom)}

SOMMAIRE DE TOUTE L'ÉMISSION (pour tes teasers et transitions) :
${sommaire}

${place}
Environ ${mots} mots d'animateur pour ce bloc, TOUS EN ${LANGS[lang].toUpperCase()}. Ne réutilise aucune phrase déjà dite (en particulier
la formule de présentation : à chaque appel une formule nouvelle).

${listing}`;
  const sys = `Tu es le producteur d'une émission de radio parlée (talk-show, libre antenne). Tu écris UNIQUEMENT ce que dit l'ANIMATEUR. Réponds en JSON valide.`;
  let best = null;
  for (let essai = 1; essai <= 3; essai++) {
    let r;
    try {
      r = await ia(sys, essai === 1 || !best ? user : user + `\n\nATTENTION, ta proposition précédente avait ces défauts, corrige-les : ${best.erreurs.join(" ; ").slice(0, 1500)}`,
        { tours: best ? 2 : 4, maxTokens: 8000 });
    } catch (e) {
      if (best) break;                               // une proposition existe déjà : on la garde (réparée plus bas)
      if (b.length > 1 && profondeur < 3) {          // bloc trop gros ou IA saturée : on le coupe en deux
        console.log(`  bloc de ${b.length} auditeurs sans réponse : coupé en deux`);
        const m = Math.ceil(b.length / 2);
        const a1 = await ecrireBloc(b.slice(0, m), { ...ctx, dernier: false }, profondeur + 1);
        const derniereLigne = [...a1.deroule].reverse().find((x) => x.type === "animateur")?.texte || avant;
        const a2 = await ecrireBloc(b.slice(m), { ...ctx, premier: false, avant: derniereLigne }, profondeur + 1);
        return { titre: a1.titre || a2.titre, deroule: [...a1.deroule, ...a2.deroule.map((x) => x.type === "appel" ? { ...x, extrait: x.extrait + m } : x)] };
      }
      console.log(`  ⚠ IA indisponible pour « ${b[0].fichier} » : diffusé sans tes phrases autour`);
      return { titre: "", deroule: b.map((c, i) => ({ type: "appel", extrait: i + 1, phrases: [0, c.phrases.length - 1], nouvel_appel: true })) };
    }
    const v = valider(r.j, b, lang);
    console.log(`    ${r.nom}, essai ${essai} : ${v.deroule.length} éléments, ${v.erreurs.length} défaut(s)${v.erreurs.length ? " — " + v.erreurs.join(" ; ").slice(0, 240) : ""}`);
    if (!best || v.erreurs.length < best.erreurs.length) best = { ...v, titre: String(r.j.titre || "").trim() };
    if (!v.erreurs.length) break;
  }
  return { titre: best.titre, deroule: await reparer(best.deroule, b, lang) };
}

async function analyse() {
  mkdirSync(OUT, { recursive: true }); mkdirSync(TMP, { recursive: true });
  let liste = [];
  try { liste = JSON.parse(readFileSync(path.join(IN, "clips.json"), "utf8")); } catch {}
  if (!Array.isArray(liste) || !liste.length)
    liste = readdirSync(path.join(IN, "clips")).filter((f) => !f.startsWith(".")).sort().map((f) => ({ fichier: f, origine: f, role: "auditeur" }));
  const tous = [];
  for (const c of liste) {
    const tj = path.join(IN, "transcripts", c.fichier + ".json");
    let r = null;
    if (existsSync(tj)) r = JSON.parse(readFileSync(tj, "utf8"));
    else if (existsSync(path.join(IN, "clips", c.fichier))) {     // pas préparé ailleurs : transcrit ici
      const p = source(c.fichier), d = duree(p);
      if (d >= 1) { console.log(`Transcription de ${c.fichier} (${d.toFixed(0)} s)…`); r = { ...(await transcrire(p, d)), duree: r2(d) }; }
    }
    if (!r) { console.log(`  ${c.origine} : illisible ou absent, ignoré`); continue; }
    const ph = phrases(r.words || []);
    if (!ph.length) { console.log(`  ${c.origine} : aucune parole reconnue, ignoré`); continue; }
    tous.push({ ...c, duree: r2(r.duree || duree(source(c.fichier))), langue: r.lang, words: r.words, phrases: ph, role: c.role || "auditeur" });
  }
  const clips = tous.filter((c) => c.role === "auditeur");
  if (!clips.length) throw new Error("aucun audio d'auditeur avec de la parole");
  // LANGUE : choisie, sinon celle des auditeurs (la majorité de leurs mots)
  const env = (process.env.RADIO_LANGUE || "auto").toLowerCase();
  const comptes = {};
  for (const c of clips) comptes[c.langue] = (comptes[c.langue] || 0) + c.words.length;
  const majo = Object.entries(comptes).sort((a, b) => b[1] - a[1])[0]?.[0];
  const lang = LANGS[env] ? env : LANGS[majo] ? majo : "fr";
  if (!LANGS[env]) console.log(`Langue de tes phrases : ${LANGS[lang]} (celle des auditeurs)`);
  const nom = (process.env.RADIO_NOM || "").trim() || NOM_DEFAUT[lang] || "";
  const ouv = tous.find((c) => c.role === "ouverture"), fin = tous.find((c) => c.role === "fin");
  // SOMMAIRE court de toute l'émission + découpage en blocs (chaque appel à l'IA reste petit : aucune IA ne sature)
  const motsSom = Math.max(4, Math.min(12, Math.floor(2400 / (clips.length * 7))));        // tous les auditeurs tiennent dans le sommaire
  const sommaire = clips.map((c, i) => `${i + 1}. ${c.phrases.map((p) => p.texte).join(" ").split(" ").slice(0, motsSom).join(" ")}…`).join("\n").slice(0, 3000);
  const B = blocs(clips);
  console.log(`${clips.length} auditeurs (${Math.round(clips.reduce((s, c) => s + c.duree, 0) / 60)} min) → ${B.length} bloc(s) écrits l'un après l'autre`);
  const deroule = [];
  let titre = "", base = 0, avant = "";
  for (let k = 0; k < B.length; k++) {
    console.log(`  bloc ${k + 1}/${B.length} : ${B[k].length} auditeur(s)`);
    const r = await ecrireBloc(B[k], { lang, nom, sommaire, premier: k === 0, dernier: k === B.length - 1, avant,
      ouverture: ouv ? ouv.phrases.map((p) => p.texte).join(" ").slice(0, 400) : "" });
    titre = titre || r.titre;
    for (const x of r.deroule) deroule.push(x.type === "appel" ? { ...x, extrait: x.extrait + base } : x);
    avant = [...r.deroule].reverse().find((x) => x.type === "animateur")?.texte || avant;
    base += B[k].length;
  }
  if (!deroule.some((x) => x.type === "animateur")) throw new Error("l'IA n'a écrit aucune phrase d'animateur (IA indisponible) : relance plus tard");
  // contrôle FINAL de toute l'émission : chaque phrase dans la bonne langue, aucune phrase répétée
  const vues = new Set(), aRevoir = [];
  for (const x of deroule) {
    if (x.type !== "animateur") continue;
    const cle = norm(x.texte).join(" ");
    const d = [];
    if (vues.has(cle)) d.push("repetee");
    if (!langueOk(x.texte, lang)) d.push("langue");
    if (d.length) { x.defauts = d; aRevoir.push(x); }
    vues.add(cle);
  }
  if (aRevoir.length) {
    console.log(`Contrôle final : ${aRevoir.length} phrase(s) répétée(s) ou pas en ${LANGS[lang]} → réécrites`);
    const ok = new Set(await reparer(aRevoir, [], lang));
    for (let k = deroule.length - 1; k >= 0; k--) if (aRevoir.includes(deroule[k]) && !ok.has(deroule[k])) deroule.splice(k, 1);
  }
  const resteFaux = deroule.filter((x) => x.type === "animateur" && !langueOk(x.texte, lang)).length;
  if (resteFaux) throw new Error(`${resteFaux} phrase(s) toujours pas en ${LANGS[lang]} après correction : relance (rien n'a été écrit dans ta release)`);
  // ordre final des fichiers du plan : auditeurs (numérotés comme dans le déroulé), puis ouverture / fin enregistrées
  const planClips = [...clips, ...(ouv ? [ouv] : []), ...(fin ? [fin] : [])];
  if (ouv) deroule.unshift({ type: "enregistre", extrait: clips.length + 1, role: "ouverture" });
  if (fin) deroule.push({ type: "enregistre", extrait: planClips.length, role: "fin" });
  let n = 0;
  for (const x of deroule) if (x.type === "animateur") x.n = ++n;
  const plan = {
    version: 2, langue: lang, nom, titre,
    clips: planClips.map((c) => ({ fichier: c.fichier, origine: c.origine || c.fichier, role: c.role, duree: c.duree, langue: c.langue,
      phrases: c.phrases.map(({ i0, i1, t0, t1, texte }) => ({ i0, i1, t0, t1, texte })), mots: c.words.map((w) => [r2(w.t0), r2(w.t1), w.w]) })),
    deroule,
  };
  writeFileSync(path.join(OUT, "emission-plan.json"), JSON.stringify(plan));
  writeFileSync(path.join(OUT, "emission-a-lire.txt"), aLire(plan));
  console.log(`Prêt : ${n} phrases à lire (${deroule.filter((x) => x.type === "animateur").reduce((s, x) => s + x.texte.split(" ").length, 0)} mots), ${Math.round((Date.now() - T0) / 60000)} min d'écriture.`);
}

/** Ce que tu lis : TES phrases numérotées, dans l'ordre, avec le ton — rien d'autre (le scénario reste dans emission-plan.json).
 *  Le ton n'est affiché que s'il est dans la langue de l'émission. */
export function aLire(plan) {
  const lang = plan.langue || "fr";
  return plan.deroule.filter((x) => x.type === "animateur")
    .map((x) => `${x.n}. ${x.ton && langueOk(x.ton, lang) ? `(${x.ton}) ` : ""}${x.texte}`).join("\n\n") + "\n";
}

// ------------------------------------------------------------------ sons d'habillage (synthétisés, bas, sans aigus)
function synth(expr, dur, out, filtres = "") {
  sh(["-f", "lavfi", "-i", `aevalsrc='${expr}':s=${SR}:d=${dur}`, "-af", `${filtres ? filtres + "," : ""}aformat=channel_layouts=mono`, "-c:a", "pcm_s16le", out]);
  return out;
}
export function jingle(out, fin = false) {
  const notes = fin ? [293.66, 246.94, 196.0, 146.83] : [146.83, 196.0, 246.94, 293.66];      // ré-sol-si-ré, grave et doux
  const parts = notes.map((f, i) => {
    const s = (i * 0.28).toFixed(2);
    return `(gte(t,${s})*exp(-2.2*(t-${s}))*(0.55*sin(2*PI*${f}*t)+0.18*sin(4*PI*${f}*t)))`;
  });
  const pad = `(0.22*sin(2*PI*${notes[0] / 2}*t)*min(1,t/0.4)*exp(-0.6*t))`;
  return synth(`0.32*(${parts.join("+")}+${pad})*min(1,(3.4-t)/0.6)`, 3.4, out, "lowpass=f=2400,aecho=0.8:0.6:70:0.22,volume=3dB");
}
export function sonnerie(out) {
  // deux sonneries douces (440 Hz modulé, comme un téléphone), puis le « clic » du décroché
  const ring = `0.09*sin(2*PI*440*t)*(0.55+0.45*sin(2*PI*22*t))*(lt(mod(t,1.6),0.95))*lt(t,2.55)`;
  const clic = `0.35*gte(t,2.75)*lt(t,2.79)*sin(2*PI*180*t)*exp(-60*(t-2.75))`;
  return synth(`${ring}+${clic}`, 2.95, out, "lowpass=f=1800");
}
function silence(out, d) { return synth("0", Math.max(0.05, d).toFixed(3), out); }

// ------------------------------------------------------------------ ÉTAPE 2 : montage avec ta voix
const TEL = "highpass=f=320,lowpass=f=3200,equalizer=f=1000:t=q:w=1:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2";
function voixAnimateur(src, out) {
  const rnn = path.join(HERE, "..", "explainer", "rnnoise", "sh.rnnn");
  const nr = existsSync(rnn) ? `arnndn=m='${rnn}':mix=0.92,afftdn=nr=4:nf=-55` : "afftdn=nr=10:nf=-52";
  const chain = `aresample=${SR},aformat=channel_layouts=mono,highpass=f=75,${nr},equalizer=f=115:t=q:w=0.9:g=3,equalizer=f=290:t=q:w=1.2:g=-2,deesser=i=0.3,acompressor=threshold=-22dB:ratio=3.5:attack=6:release=140:knee=6:makeup=3.5,alimiter=limit=0.9,loudnorm=I=-16:TP=-1.5:LRA=11`;
  try { sh(["-i", src, "-af", chain, "-c:a", "pcm_s16le", out]); }
  catch { sh(["-i", src, "-af", `aresample=${SR},aformat=channel_layouts=mono,highpass=f=75,afftdn=nr=10:nf=-52,loudnorm=I=-16:TP=-1.5:LRA=11`, "-c:a", "pcm_s16le", out]); }
}
function couper(src, t0, t1, out, filtre = "") {
  sh(["-ss", Math.max(0, t0).toFixed(3), "-t", Math.max(0.1, t1 - t0).toFixed(3), "-i", src, "-af",
    `aresample=${SR},aformat=channel_layouts=mono,${filtre ? filtre + "," : ""}afade=t=in:d=0.04,areverse,afade=t=in:d=0.08,areverse`, "-c:a", "pcm_s16le", out]);
  return out;
}

async function montage() {
  mkdirSync(TMP, { recursive: true });
  const plan = JSON.parse(readFileSync(path.join(IN, "plan.json"), "utf8"));
  const voixF = readdirSync(IN).find((f) => /^voix\./.test(f));
  if (!voixF) throw new Error("ta voix est introuvable");
  const voix = path.join(IN, voixF), dv = duree(voix);
  console.log(`Transcription de ta voix (${dv.toFixed(0)} s)…`);
  process.env.ASR_LANGUAGE = plan.langue || "";
  const rv = await transcrire(voix, dv);
  delete process.env.ASR_LANGUAGE;
  const anim = plan.deroule.filter((x) => x.type === "animateur");
  if (!rv.words.length) throw new Error("aucune parole reconnue dans ta voix (fichier vide ou muet ?)");
  const exact = aligner(anim.map((x) => x.texte), rv.words);
  const al = placerParPosition(anim.map((x) => x.texte), rv.words, exact);
  const manquent = [], placees = [];
  anim.forEach((x, k) => { x.al = al[k]; if (!al[k]) manquent.push(x.n); else if (al[k].position) placees.push(x.n); });
  console.log(`Tes phrases : ${anim.length - manquent.length - placees.length} reconnues mot pour mot, ${placees.length} placées par position (dites avec tes mots)${manquent.length ? `, ${manquent.length} sans voix (n° ${manquent.join(", ")})` : ""}`);
  const vtrait = path.join(TMP, "voix-traitee.wav");
  voixAnimateur(voix, vtrait);
  // pièces dans l'ordre
  const pieces = [], mots = [];
  let k = 0, t = 0;
  // chaque pièce ajoutée avance l'horloge de l'émission ; ses mots (connus) sont recalés : la vidéo n'a rien à re-transcrire
  const add = (f, gap = 0.35, ws = []) => {
    for (const w of ws) mots.push({ t0: r2(t + w[0]), t1: r2(t + w[1]), w: w[2] });
    pieces.push(f); t += duree(f);
    if (gap > 0) { pieces.push(silence(path.join(TMP, `sil-${k++}.wav`), gap)); t += gap; }
  };
  const motsDe = (liste, a, b, decal = 0) => liste.filter((w) => w[0] >= a - 0.01 && w[1] <= b + 0.01).map((w) => [w[0] - a + decal, w[1] - a + decal, w[2]]);
  const motsVoix = rv.words.map((w) => [w.t0, w.t1, w.w]);
  add(jingle(path.join(TMP, "jingle-debut.wav")), 0.25);
  const d = plan.deroule;
  const animPiece = (x) => {
    // marges sans jamais mordre sur le mot d'avant / d'après (autre phrase, prise ratée)
    const a0 = Math.max(x.al.t0 - 0.12, Math.min(x.al.t0, x.al.avant + 0.03));
    const a1 = Math.min(x.al.t1 + 0.3, Math.max(x.al.t1, x.al.apres - 0.03));
    x.bornes = [a0, a1];
    return couper(vtrait, a0, a1, path.join(TMP, `anim-${x.n}.wav`));
  };
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    if (x.type === "animateur") {
      if (!x.al || x.fait) continue;
      const f = animPiece(x);
      add(f, x.mode === "silence" ? 0.15 : 0.3, motsDe(motsVoix, ...x.bornes));
    } else if (x.type === "enregistre") {
      // ouverture / fin que TU as préparées (nom « start / intro / générique… ») : diffusées telles quelles, musique comprise
      const c = plan.clips[x.extrait - 1];
      const src = existsSync(path.join(IN, "clips", c.fichier)) ? path.join(IN, "clips", c.fichier) : source(c.fichier);
      const f = path.join(TMP, `enregistre-${i}.wav`);
      sh(["-i", src, "-vn", "-af", `aresample=${SR},aformat=channel_layouts=mono,loudnorm=I=-16:TP=-1.5:LRA=11`, "-ar", String(SR), "-ac", "1", "-c:a", "pcm_s16le", f]);
      add(f, 0.4, (c.mots || []).map((w) => [w[0], w[1], w[2]]));
    } else {
      const c = plan.clips[x.extrait - 1];
      const src = source(c.fichier);
      let p0 = c.phrases[x.phrases[0]];
      const p1 = c.phrases[x.phrases[1]];
      let avant = x.phrases[0] > 0 ? c.phrases[x.phrases[0] - 1].t1 : 0;
      // « Salam aleykoum à tous… », « Bonsoir tout le monde… » : jamais diffusé, l'auditeur entre dans le sujet
      if (Array.isArray(c.mots) && c.mots.length > p1.i1) {
        const k = apresSalut(c.mots, p0.i0, p1.i1);
        if (k > p1.i1) {                       // le morceau n'était qu'une salutation : sauté
          console.log(`  auditeur ${x.extrait} : morceau de salutation seule, retiré`);
          if (x.nouvel_appel) { const nx = d.slice(i + 1).find((y) => y.type === "appel" && y.extrait === x.extrait); if (nx) nx.nouvel_appel = true; }
          continue;
        }
        if (k > p0.i0) { console.log(`  auditeur ${x.extrait} : salutation retirée (« ${c.mots.slice(p0.i0, k).map((w) => w[2]).join(" ")} »)`); avant = c.mots[k - 1][1]; p0 = { ...p0, t0: c.mots[k][0] }; }
      }
      if (x.nouvel_appel) add(sonnerie(path.join(TMP, `sonnerie-${i}.wav`)), 0.15);
      const apres = x.phrases[1] + 1 < c.phrases.length ? c.phrases[x.phrases[1] + 1].t0 : c.duree;
      const b0 = Math.max(p0.t0 - 0.08, Math.min(p0.t0, avant + 0.03));
      const b1 = Math.min(p1.t1 + 0.25, Math.max(p1.t1, apres - 0.03));
      const suivant = d[i + 1];
      const coupe = suivant?.type === "animateur" && suivant.mode === "coupe" && suivant.al;
      // COUPE : l'auditeur continue de parler ~0,8 s (le début de sa phrase suivante), sa voix s'efface sous la tienne
      const OVL = coupe ? Math.max(0, Math.min(0.8, c.duree - b1 - 0.05)) : 0;
      const brut = couper(src, b0, b1 + OVL, path.join(TMP, `appel-${i}-brut.wav`), TEL);
      const fin = path.join(TMP, `appel-${i}.wav`);
      sh(["-i", brut, "-af", "loudnorm=I=-19:TP=-2:LRA=9", "-ar", String(SR), "-c:a", "pcm_s16le", fin]);
      if (coupe && OVL > 0.3) {
        const lg = duree(fin), host = animPiece(suivant), mix = path.join(TMP, `coupe-${i}.wav`);
        const st = Math.max(0, lg - OVL);
        sh(["-i", fin, "-i", host, "-filter_complex",
          `[0:a]volume='if(gte(t,${st.toFixed(3)}),max(0.12,1-(t-${st.toFixed(3)})/${OVL.toFixed(3)}),1)':eval=frame[a];` +
          `[1:a]adelay=${Math.round(st * 1000)}:all=1[b];[a][b]amix=inputs=2:duration=longest:normalize=0[o]`,
          "-map", "[o]", "-ar", String(SR), "-ac", "1", "-c:a", "pcm_s16le", mix]);
        suivant.fait = true;
        add(mix, 0.12, [...motsDe(c.mots || [], b0, b1), ...motsDe(motsVoix, ...suivant.bornes, st)]);   // l'auditeur enchaîne tout de suite
      } else add(fin, suivant?.type === "animateur" && suivant.mode === "silence" ? 0.18 : 0.3, motsDe(c.mots || [], b0, b1));
    }
  }
  add(jingle(path.join(TMP, "jingle-fin.wav"), true), 0);
  const liste = path.join(TMP, "liste.txt");
  writeFileSync(liste, pieces.map((p) => `file '${path.resolve(p)}'`).join("\n"));
  const brut = path.join(TMP, "emission-brut.wav");
  sh(["-f", "concat", "-safe", "0", "-i", liste, "-c:a", "pcm_s16le", brut]);
  // niveau final YouTube (−14 LUFS) en deux passes, sans pompage
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostats", "-i", brut, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 27 });
  const m = (r.stderr || "").match(/\{[^{}]*"input_i"[^{}]*\}/);
  const j = m ? JSON.parse(m[0]) : null;
  const ln = j && Number(j.input_i) > -70 ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true` : "loudnorm=I=-14:TP=-1.5:LRA=11";
  const mp3 = path.join(OUT, "emission.mp3");
  sh(["-i", brut, "-af", `${ln},aresample=44100`, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "160k", mp3]);
  mots.sort((x, y) => x.t0 - y.t0);
  writeFileSync(path.join(OUT, "voix-transcript.json"), JSON.stringify({ lang: plan.langue || "fr", duration: r2(duree(mp3)), words: mots, source: "emission-radio" }));
  const auditeurs = plan.clips.filter((c) => (c.role || "auditeur") === "auditeur").length;
  const rapport = [`# 🎙 ${plan.titre || "Émission"}`, "", `Durée : ${(duree(mp3) / 60).toFixed(1)} min — ${auditeurs} auditeur(s), ${anim.length - manquent.length}/${anim.length} phrases de toi.`,
    ...(placees.length ? ["", `Phrases dites avec tes mots (placées dans l'ordre) : n° ${placees.join(", ")}.`] : []),
    ...(manquent.length ? ["", `⚠ Aucun passage de ta voix pour : n° ${manquent.join(", ")}.`] : []),
    "", "| n° | trouvée | prises | début dans ta voix |", "|---|---|---|---|",
    ...anim.map((x) => `| ${x.n} | ${x.al ? (x.al.position ? "oui (tes mots)" : `oui (${Math.round(x.al.score * 100)} %)`) : "**non**"} | ${x.al ? x.al.prises : "–"} | ${x.al ? x.al.t0.toFixed(1) + " s" : "–"} |`)];
  writeFileSync(path.join(OUT, "rapport.md"), rapport.join("\n") + "\n");
  console.log(rapport.slice(0, 4).join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const etape = process.argv[2];
  try {
    if (etape === "transcrire") await transcrireFichiers(process.argv.slice(3));
    else if (etape === "analyse") await analyse();
    else if (etape === "montage") await montage();
    else throw new Error("usage : node emission.mjs transcrire <fichiers>|analyse|montage");
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  } finally { try { if (!process.env.GARDER_TMP) rmSync(TMP, { recursive: true, force: true }); } catch {} }
}
