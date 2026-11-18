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
  const cands = (li, from) => {                       // fenêtres où la phrase li est lue (score ≥ seuil), maxima locaux
    const toks = L[li], n = toks.length, res = [];
    if (!n) return res;
    const seuil = n <= 6 ? 0.72 : 0.6;
    for (let p = from; p < T.length; p++) {
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

// ------------------------------------------------------------------ IA
async function ia(sys, user, essais = 3) {
  const prov = providers();
  if (!prov.length) throw new Error("aucune clé IA (GEMINI_API_KEY / GROQ_API_KEY) : impossible d'écrire tes phrases");
  let last = null;
  for (let k = 0; k < essais; k++) {
    for (const [nom, fn] of prov) {
      try {
        const raw = await fn(sys, user, { json: true, temperature: 0.75, maxTokens: 12000, deadline: Date.now() + 8 * 60 * 1000 });
        const j = parseJson(raw);
        if (j) return { j, nom };
        last = new Error(`${nom} : réponse illisible`);
      } catch (e) { last = e; console.log(`  ${nom} : ${String(e.message).slice(0, 160)}`); }
    }
  }
  throw last || new Error("IA indisponible");
}

/** Vérifie et répare le déroulé proposé par l'IA. Renvoie { deroule, erreurs[] } (erreurs bloquantes → nouvel essai). */
export function valider(j, clips) {
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
      if (/\b(nous|notre|nos)\b/i.test(t)) erreurs.push(`« nous » interdit : « ${t.slice(0, 60)} »`);
      if (t.split(" ").length < 5) { erreurs.push(`phrase trop courte pour être reconnue (5 mots minimum) : « ${t} »`); continue; }
      let mode = String(it.mode || "normal").toLowerCase();
      mode = mode.startsWith("coup") ? "coupe" : mode.startsWith("sil") ? "silence" : "normal";
      // couper la parole / profiter d'un silence : seulement AU MILIEU d'un appel (l'auditeur était en train de parler)
      if (mode !== "normal" && out[out.length - 1]?.type !== "appel") mode = "normal";
      out.push({ type: "animateur", role: String(it.role || "relance"), mode, ton: String(it.ton || "").replace(/\s+/g, " ").trim().slice(0, 60), texte: t });
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
  if (!out.length || out[0].type !== "animateur") erreurs.push("l'émission doit commencer par l'animateur");
  if (!out.length || out[out.length - 1].type !== "animateur") erreurs.push("l'émission doit finir par l'animateur");
  for (let k = 1; k < out.length; k++) {
    if (out[k].type === "appel" && out[k].nouvel_appel && out[k - 1].type !== "animateur") erreurs.push(`appel de l'extrait ${out[k].extrait} lancé sans présentation`);
  }
  return { deroule: out, erreurs };
}

// ------------------------------------------------------------------ ÉTAPE 1 : analyse → tes phrases à lire
async function analyse() {
  mkdirSync(OUT, { recursive: true }); mkdirSync(TMP, { recursive: true });
  const files = readdirSync(path.join(IN, "clips")).filter((f) => !f.startsWith(".")).sort();
  if (!files.length) throw new Error("aucun audio dans la release");
  const clips = [];
  for (const f of files) {
    const p = path.join(IN, "clips", f), d = duree(p);
    if (d < 1) { console.log(`  ${f} : illisible ou vide, ignoré`); continue; }
    console.log(`Transcription de ${f} (${d.toFixed(0)} s)…`);
    const r = await transcrire(p, d);
    const ph = phrases(r.words);
    if (!ph.length) { console.log(`  ${f} : aucune parole reconnue, ignoré`); continue; }
    clips.push({ fichier: f, duree: r2(d), langue: r.lang, words: r.words, phrases: ph });
  }
  if (!clips.length) throw new Error("aucun audio avec de la parole");
  const env = (process.env.RADIO_LANGUE || "auto").toLowerCase();
  const lang = LANGS[env] ? env : "fr";
  const nom = (process.env.RADIO_NOM || "").trim() || NOM_DEFAUT[lang] || "";
  const total = clips.reduce((s, c) => s + c.duree, 0);
  const motsAnim = Math.round(Math.max(150, Math.min(2500, total / 60 * 55)));     // ≈ 1/3 du temps d'antenne pour toi
  const listing = clips.map((c, k) => `EXTRAIT ${k + 1} — ${c.duree.toFixed(0)} s, langue ${c.langue} :\n` +
    c.phrases.map((p, i) => `  [${i}] ${p.texte}`).join("\n")).join("\n\n");
  const sys = `Tu es le producteur d'une émission de radio parlée (talk-show, libre antenne). Tu écris UNIQUEMENT ce que dit l'ANIMATEUR. Réponds en JSON valide.`;
  const user = `Les EXTRAITS ci-dessous seront diffusés comme des AUDITEURS QUI APPELLENT L'ÉMISSION (voix au téléphone). Écris le déroulé
complet d'une émission RÉALISTE, en ${LANGS[lang]}, où l'animateur (l'utilisateur, qui lira tes phrases à voix haute) :
- ouvre l'émission${nom ? ` « ${nom} »` : ""} : accroche forte sur le ou les sujets du jour, annonce que le standard est ouvert ;
- présente CHAQUE appel avant de le diffuser (« On a un auditeur en ligne… bonsoir, vous êtes à l'antenne, je vous écoute. ») ;
- découpe les appels longs (plus de 25 s) en morceaux de 15 à 40 s environ et intervient entre eux de DEUX façons, en les variant :
  « coupe » = l'animateur COUPE LA PAROLE à l'auditeur (qui parle encore) : 5 à 12 mots, réflexe, vif (« Attendez, attendez… vous êtes
  en train de dire que… ? »), puis l'auditeur enchaîne ; « silence » = l'animateur profite d'une pause de l'auditeur pour glisser une
  question précise, une objection ou une remarque ironique. Dans les deux cas, la phrase rebondit EXACTEMENT sur ce que l'auditeur vient
  de dire et amène ce qu'il dit ensuite (le morceau suivant doit y répondre de façon crédible) ;
- peut écarter des phrases sans intérêt d'un extrait (bégaiements, hors-sujet, musique), sans jamais changer l'ordre d'un extrait ;
- réagit après chaque appel (analyse, contradiction, humour noir, chiffre ou fait SEULEMENT s'il est dit dans les extraits),
  remercie l'auditeur, puis fait la TRANSITION vers l'appel suivant : même sujet → « un autre auditeur n'est pas d'accord… » ;
  sujet différent → vraie transition de radio vers le nouveau sujet ;
- relance l'écoute de temps en temps (« appelez, réagissez dans les commentaires, partagez »), sans jamais donner d'heure ni de date ;
- conclut : synthèse percutante, question ouverte au public, au revoir.
ÉCRITURE DE SCÉNARISTE RADIO EXPERT : cold open qui accroche dès la première phrase ; promesses et teasers avant les appels (« écoutez
bien la suite, elle va vous faire bondir ») ; reformulation choc de ce que vient de dire l'auditeur ; contradiction et avocat du diable ;
punchline d'humour noir après les moments forts ; rythme varié (phrases d'un mot, questions rapides, silences) ; jamais deux fois la
même formule de présentation ; chaque appel a sa propre couleur (colère, témoignage, expert du quotidien, contradicteur) d'après ce
qu'il dit ; tension qui monte jusqu'au dernier appel. Pour CHAQUE phrase de l'animateur, indique le TON de lecture en 2 à 4 mots
(« sec, indigné », « ironique », « complice », « grave, lent », « amusé », « faussement naïf »…).
STYLE : oral, vivant, phrases courtes, animateur de libre antenne provocateur mais crédible ; vouvoiement du public et des
auditeurs. HORS DU CONTEXTE : jamais « nous », « notre », « nos » (ni leur équivalent dans la langue de l'émission) : dis « la France »,
« les Français », « vous », « je ». N'invente AUCUN fait, aucun prénom, aucune ville d'auditeur ; ne dis jamais que ce sont des vidéos
ou TikTok : ce sont des auditeurs au téléphone. Chaque phrase de l'animateur fait AU MOINS 8 mots (5 pour une « coupe ») pour être
reconnue quand il la lira, et au plus 70 mots. Environ ${motsAnim} mots d'animateur au total. Tous les extraits sont diffusés, dans l'ordre donné.
Réponds en JSON :
{"titre": "titre accrocheur de l'émission",
 "deroule": [
  {"type": "animateur", "role": "ouverture", "ton": "…", "texte": "…"},
  {"type": "animateur", "role": "presentation", "ton": "…", "texte": "…"},
  {"type": "appel", "extrait": 1, "phrases": [0, 4], "nouvel_appel": true},
  {"type": "animateur", "role": "relance", "mode": "coupe", "ton": "sec, incrédule", "texte": "…"},
  {"type": "appel", "extrait": 1, "phrases": [5, 9], "nouvel_appel": false},
  {"type": "animateur", "role": "relance", "mode": "silence", "ton": "faussement naïf", "texte": "…"},
  {"type": "appel", "extrait": 1, "phrases": [10, 14], "nouvel_appel": false},
  {"type": "animateur", "role": "reaction", "ton": "…", "texte": "…"},
  …
  {"type": "animateur", "role": "cloture", "texte": "…"}]}
("phrases": [première, dernière] = numéros [i] des phrases de l'extrait diffusées dans ce morceau.)

${listing}`;
  let best = null;
  for (let essai = 1; essai <= 3; essai++) {
    const { j, nom: fournisseur } = await ia(sys, essai === 1 ? user : user + `\n\nATTENTION, ta proposition précédente avait ces défauts, corrige-les : ${best.erreurs.join(" ; ")}`, 2);
    const v = valider(j, clips);
    console.log(`  déroulé (${fournisseur}, essai ${essai}) : ${v.deroule.length} éléments, ${v.erreurs.length} défaut(s)${v.erreurs.length ? " — " + v.erreurs.join(" ; ").slice(0, 300) : ""}`);
    if (!best || v.erreurs.length < best.erreurs.length) best = { ...v, titre: String(j.titre || "").trim() };
    if (!v.erreurs.length) break;
  }
  if (!best.deroule.some((x) => x.type === "animateur")) throw new Error("l'IA n'a écrit aucune phrase d'animateur");
  let origines = {};
  try { origines = JSON.parse(readFileSync(path.join(IN, "clips.json"), "utf8")); } catch {}
  // numérotation des phrases à lire
  let n = 0;
  for (const x of best.deroule) if (x.type === "animateur") x.n = ++n;
  const plan = {
    version: 1, langue: lang, nom, titre: best.titre, defauts: best.erreurs,
    clips: clips.map((c) => ({ fichier: c.fichier, origine: origines[c.fichier] || c.fichier, duree: c.duree, langue: c.langue, phrases: c.phrases.map(({ i0, i1, t0, t1, texte }) => ({ i0, i1, t0, t1, texte })) })),
    deroule: best.deroule,
  };
  writeFileSync(path.join(OUT, "emission-plan.json"), JSON.stringify(plan, null, 1));
  writeFileSync(path.join(OUT, "emission-a-lire.txt"), aLire(plan));
  console.log(`Prêt : ${n} phrases à lire (${best.deroule.filter((x) => x.type === "animateur").reduce((s, x) => s + x.texte.split(" ").length, 0)} mots).`);
}

function extraitCourt(plan, x, fin = false) {
  const c = plan.clips[x.extrait - 1];
  const ps = c.phrases.slice(x.phrases[0], x.phrases[1] + 1).map((p) => p.texte).join(" ").split(" ");
  return (fin ? "… " + ps.slice(-14).join(" ") : ps.slice(0, 14).join(" ") + " …");
}
export function aLire(plan) {
  const L = [`🎙 ${plan.titre || "Émission"}${plan.nom ? ` — ${plan.nom}` : ""}`, "",
    "COMMENT ENREGISTRER : lis toutes les phrases ci-dessous, DANS L'ORDRE, en un seul enregistrement.",
    "Marque une petite pause (1 seconde) entre deux phrases. Une phrase ratée ? Relis-la simplement : la dernière prise est gardée.",
    "Ne lis PAS les numéros ni les lignes entre crochets. Dépose ensuite ton audio dans la MÊME release et relance « Émission radio ».", ""];
  const d = plan.deroule;
  for (let k = 0; k < d.length; k++) {
    const x = d[k];
    if (x.type !== "animateur") continue;
    const avant = d.slice(0, k).reverse().find((y) => y.type === "appel");
    const apres = d[k + 1]?.type === "appel" ? d[k + 1] : null;
    L.push(`${x.n}.`);
    if (avant && d[k - 1]?.type === "appel") L.push(`[ l'auditeur vient de dire : « ${extraitCourt(plan, avant, true)} » ]`);
    const consigne = [x.mode === "coupe" ? "TU LUI COUPES LA PAROLE" : x.mode === "silence" ? "tu profites de son silence" : "", x.ton ? `ton : ${x.ton}` : ""].filter(Boolean).join(" — ");
    if (consigne) L.push(`[ ${consigne} ]`);
    L.push(x.texte);
    if (apres) L.push(`[ ${apres.nouvel_appel ? "☎ sonnerie, puis l'auditeur" : "l'auditeur reprend"} : « ${extraitCourt(plan, apres)} » ]`);
    L.push("");
  }
  return L.join("\n");
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
  const al = aligner(anim.map((x) => x.texte), rv.words);
  const manquent = [];
  anim.forEach((x, k) => { x.al = al[k]; if (!al[k]) manquent.push(x.n); });
  console.log(`Tes phrases retrouvées : ${anim.length - manquent.length}/${anim.length}${manquent.length ? ` (introuvables : n° ${manquent.join(", ")} — sautées)` : ""}`);
  if (anim.length - manquent.length < Math.ceil(anim.length / 2)) throw new Error(`seulement ${anim.length - manquent.length} phrases sur ${anim.length} retrouvées dans ta voix : as-tu lu le bon texte (emission-a-lire.txt de cette release) ?`);
  const vtrait = path.join(TMP, "voix-traitee.wav");
  voixAnimateur(voix, vtrait);
  // pièces dans l'ordre
  const pieces = [];
  let k = 0;
  const add = (f, gap = 0.35) => { pieces.push(f); if (gap > 0) pieces.push(silence(path.join(TMP, `sil-${k++}.wav`), gap)); };
  add(jingle(path.join(TMP, "jingle-debut.wav")), 0.25);
  const d = plan.deroule;
  const animPiece = (x) => {
    // marges sans jamais mordre sur le mot d'avant / d'après (autre phrase, prise ratée)
    const a0 = Math.max(x.al.t0 - 0.12, Math.min(x.al.t0, x.al.avant + 0.03));
    const a1 = Math.min(x.al.t1 + 0.3, Math.max(x.al.t1, x.al.apres - 0.03));
    return couper(vtrait, a0, a1, path.join(TMP, `anim-${x.n}.wav`));
  };
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    if (x.type === "animateur") {
      if (!x.al || x.fait) continue;
      add(animPiece(x), x.mode === "silence" ? 0.15 : 0.3);
    } else {
      const c = plan.clips[x.extrait - 1];
      const src = path.join(IN, "clips", c.fichier);
      const p0 = c.phrases[x.phrases[0]], p1 = c.phrases[x.phrases[1]];
      if (x.nouvel_appel) add(sonnerie(path.join(TMP, `sonnerie-${i}.wav`)), 0.15);
      const avant = x.phrases[0] > 0 ? c.phrases[x.phrases[0] - 1].t1 : 0;
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
        add(mix, 0.12);                    // l'auditeur enchaîne tout de suite
      } else add(fin, suivant?.type === "animateur" && suivant.mode === "silence" ? 0.18 : 0.3);
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
  const rapport = [`# 🎙 ${plan.titre || "Émission"}`, "", `Durée : ${(duree(mp3) / 60).toFixed(1)} min — ${plan.clips.length} auditeur(s), ${anim.length - manquent.length}/${anim.length} phrases de toi.`,
    ...(manquent.length ? ["", `⚠ Phrases introuvables dans ta voix (sautées) : n° ${manquent.join(", ")}.`] : []),
    "", "| n° | trouvée | prises | début dans ta voix |", "|---|---|---|---|",
    ...anim.map((x) => `| ${x.n} | ${x.al ? `oui (${Math.round(x.al.score * 100)} %)` : "**non**"} | ${x.al ? x.al.prises : "–"} | ${x.al ? x.al.t0.toFixed(1) + " s" : "–"} |`)];
  writeFileSync(path.join(OUT, "rapport.md"), rapport.join("\n") + "\n");
  console.log(rapport.slice(0, 4).join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const etape = process.argv[2];
  try {
    if (etape === "analyse") await analyse();
    else if (etape === "montage") await montage();
    else throw new Error("usage : node emission.mjs analyse|montage");
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  } finally { try { if (!process.env.GARDER_TMP) rmSync(TMP, { recursive: true, force: true }); } catch {} }
}
