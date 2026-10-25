// scripts/transcribe.mjs
// Transcrit input/video.* en texte AVEC horodatage mot à mot : Groq Whisper (gratuit, en ligne) si une clé
// existe, sinon whisper.cpp local (compilé par le workflow). Vidéos longues : découpage en morceaux de 10 min. Produit :
//   content/transcript.json  -> { lang, duration, words:[{t0,t1,w}] }  (sert au montage)
//   content/script.txt       -> texte brut (sert à l'écriture des headlines)
// Si content/script.txt existe déjà (texte fourni par toi), il est conservé :
// le texte vient de toi, mais les horaires viennent quand même de la vidéo si
// elle est présente (sinon ils sont répartis régulièrement sur la durée).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { CONTENT_DIR, findVideo, probeVideo, detectLanguage, normLang } from "./lib/util.mjs";
import { groqKeys } from "./lib/llm.mjs";

const OUT_TXT = path.join(CONTENT_DIR, "script.txt");
const OUT_JSON = path.join(CONTENT_DIR, "transcript.json");
const WHISPER_BIN = "whisper.cpp/build/bin/whisper-cli";
// Modèles locaux par ordre de préférence : le plus précis disponible (large-v3-turbo comprend bien mieux l'arabe dialectal que small).
const WHISPER_MODELS = ["ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-small.bin"].map((m) => `whisper.cpp/models/${m}`);
const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";
const LANG_MAP = { arabic: "ar", french: "fr", english: "en", italian: "it" };

// Transcription en ligne GRATUITE via Groq (Whisper large-v3, mots horodatés) si GROQ_API_KEY(S) existe.
// Plusieurs clés acceptées (rotation). Vidéo longue : l'audio est découpé en morceaux de 10 min (limite d'envoi
// gratuite ≈ 25 Mo), chaque morceau est transcrit puis recalé ; un morceau refusé par Groq passe au whisper local.
let groqDeadUntil = 0;
const ASR_MODELS = [process.env.GROQ_ASR_MODEL || "whisper-large-v3", "whisper-large-v3-turbo"].filter((m, i, a) => a.indexOf(m) === i);
let asrModel = ASR_MODELS[0];
async function groqFile(mp3) {
  const keys = groqKeys();
  if (!keys.length || Date.now() < groqDeadUntil) return null;
  const buf = readFileSync(mp3);
  if (buf.length > 24 * 1024 * 1024) throw new Error("audio trop gros pour l'envoi (> 24 Mo)");
  for (let attempt = 0; attempt < 2; attempt++) {
    let minWait = Infinity;
    for (let ki = 0; ki < keys.length; ki++) {
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
      fd.append("model", asrModel);
      fd.append("response_format", "verbose_json");
      fd.append("timestamp_granularities[]", "word");
      fd.append("timestamp_granularities[]", "segment"); // les segments portent la ponctuation (les mots Groq n'en ont pas)
      fd.append("temperature", "0");
      if (process.env.ASR_LANGUAGE) fd.append("language", process.env.ASR_LANGUAGE);
      const res = await fetch(`${GROQ_BASE}/openai/v1/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${keys[ki]}` }, body: fd, signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after")) || 20;
        minWait = Math.min(minWait, ra);
        console.log(`  Groq (transcription, clé ${ki + 1}/${keys.length}) : limite atteinte (réessai dans ${ra}s)`);
        continue;
      }
      if (!res.ok) {
        const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
        // modèle retiré par Groq : on passe au suivant au lieu d'abandonner Groq
        if ((res.status === 404 || res.status === 400) && /model/i.test(body) && ASR_MODELS.indexOf(asrModel) < ASR_MODELS.length - 1) {
          asrModel = ASR_MODELS[ASR_MODELS.indexOf(asrModel) + 1]; console.log(`  Groq : modèle de transcription indisponible → ${asrModel}`); ki--; continue;
        }
        throw new Error(`HTTP ${res.status} ${body}`);
      }
      const j = await res.json();
      const words = (j.words || []).map((w) => ({ t0: Number(w.start), t1: Number(w.end), w: String(w.word || "").trim() })).filter((w) => w.w && isFinite(w.t0));
      const l = String(j.language || "").toLowerCase();
      return { lang: LANG_MAP[l] || l, words: punctuate(words, j.segments || []) };
    }
    // quota horaire épuisé (attente longue) : inutile d'attendre, on passe au local pour la suite
    if (minWait > 75) { groqDeadUntil = Date.now() + minWait * 1000; throw new Error(`quota Groq épuisé pour ${Math.round(minWait / 60)} min`); }
    console.log(`  pause ${minWait}s...`);
    await new Promise((r) => setTimeout(r, minWait * 1000));
  }
  throw new Error("limite de débit persistante");
}

// Recopie la ponctuation des segments sur les mots (« dit » → « dit, » / « fin » → « fin. ») : indispensable pour
// découper en vraies phrases (choix des shorts, sous-titres, beats). Alignement mot à mot tolérant.
const normW = (t) => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f\u064B-\u065F\u0640]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
export function punctuate(words, segments) {
  if (!segments.length || !words.length) return words;
  const out = words.map((w) => ({ ...w }));
  let wi = 0, fixed = 0;
  for (const seg of segments) {
    const toks = String(seg.text || "").trim().split(/\s+/).filter(Boolean);
    let last = -1;
    for (const tok of toks) {
      const nt = normW(tok);
      const punct = (tok.match(/[.!?؟…,;:،]+["»”]?$/) || [""])[0];
      const put = (k) => { if (punct && !out[k].w.endsWith(punct)) { out[k].w = out[k].w.replace(/[.!?؟…,;:،]+$/, "") + punct; fixed++; } };
      if (!nt) { if (punct && last >= 0) put(last); continue; } // « ? » isolé (français) : rattaché au mot précédent
      // cherche le mot correspondant dans une petite fenêtre (Groq fusionne/sépare parfois des mots : « aujourd » + « hui »)
      for (let k = wi; k < Math.min(out.length, wi + 4); k++) {
        if (normW(out[k].w) === nt) { put(k); wi = k + 1; last = k; break; }
        if (k + 1 < out.length && normW(out[k].w + out[k + 1].w) === nt) { put(k + 1); wi = k + 2; last = k + 1; break; }
      }
    }
    // fin de segment Whisper = fin d'énoncé : si le dernier mot du segment n'a rien, on ne force pas (évite les faux points)
  }
  if (fixed) console.log(`  ponctuation recopiée sur ${fixed} mots`);
  return out;
}

function localWhisper(wav, label = "") {
  const model = WHISPER_MODELS.find((m) => existsSync(m));
  if (!existsSync(WHISPER_BIN) || !model) throw new Error("whisper.cpp ou son modèle est introuvable (voir le workflow).");
  console.log(`Whisper local${label} : ${path.basename(model)}`);
  const outBase = path.resolve(wav.replace(/\.wav$/, "") + "-whisper");
  execFileSync(WHISPER_BIN, ["-m", model, "-f", path.resolve(wav), "-l", process.env.ASR_LANGUAGE || "auto", "-ml", "1", "-sow", "-oj", "-of", outBase], { stdio: "inherit" });
  const j = JSON.parse(readFileSync(outBase + ".json", "utf8"));
  const words = [];
  for (const seg of j.transcription || []) {
    const w = (seg.text || "").trim();
    if (!w || /^\[.*\]$/.test(w) || /^\(.*\)$/.test(w)) continue; // [MUSIC], (rires)...
    words.push({ t0: parseOffsetMs(seg, "from") / 1000, t1: parseOffsetMs(seg, "to") / 1000, w });
  }
  return { lang: j.result && j.result.language, words };
}

const CHUNK = Number(process.env.ASR_CHUNK_SEC || 600);
async function transcribeAll(video, duration) {
  const n = duration > CHUNK * 1.5 ? Math.ceil(duration / CHUNK) : 1;
  const words = [];
  const langs = {};
  let engines = new Set();
  for (let i = 0; i < n; i++) {
    const off = i * CHUNK;
    const cut = n > 1 ? ["-ss", String(off), "-t", String(CHUNK)] : [];
    const label = n > 1 ? ` [morceau ${i + 1}/${n}]` : "";
    let r = null;
    if (groqKeys().length && Date.now() >= groqDeadUntil) {
      try {
        const mp3 = path.join(CONTENT_DIR, `audio-asr-${i}.mp3`);
        execFileSync("ffmpeg", ["-y", "-v", "error", ...cut, "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3], { stdio: ["ignore", "ignore", "inherit"] });
        r = await groqFile(mp3);
        if (r && !r.words.length && n === 1) { console.log("Groq : aucun mot horodaté — repli sur whisper local."); r = null; }
        if (r) engines.add("Groq Whisper large-v3");
      } catch (e) {
        console.log(`Transcription Groq indisponible${label} (${e.message}) — repli sur whisper local.`);
        r = null;
      }
    }
    if (!r) {
      const wav = path.join(CONTENT_DIR, n > 1 ? `audio-${i}.wav` : "audio.wav");
      execFileSync("ffmpeg", ["-y", "-v", "error", ...cut, "-i", video, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { stdio: "inherit" });
      r = localWhisper(wav, label);
      engines.add("whisper local");
    }
    for (const w of r.words) words.push({ t0: +(w.t0 + off).toFixed(3), t1: +(w.t1 + off).toFixed(3), w: w.w });
    const lg = normLang(r.lang);
    langs[lg] = (langs[lg] || 0) + r.words.length;
    if (n > 1) console.log(`  morceau ${i + 1}/${n} : ${r.words.length} mots`);
  }
  const lang = Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0] || "fr";
  return { lang, words, engine: [...engines].join(" + ") };
}

function hasUsableScript() {
  return existsSync(OUT_TXT) && readFileSync(OUT_TXT, "utf8").trim().length > 0;
}

function parseOffsetMs(seg, key) {
  if (seg.offsets && seg.offsets[key] !== undefined) return seg.offsets[key];
  const ts = seg.timestamps && seg.timestamps[key];
  if (!ts) return 0;
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] : 0;
}

function evenlySpread(text, duration) {
  const ws = text.split(/\s+/).filter(Boolean);
  const step = duration / Math.max(1, ws.length);
  return ws.map((w, i) => ({ t0: i * step, t1: (i + 1) * step * 0.95, w }));
}

async function main() {
  mkdirSync(CONTENT_DIR, { recursive: true });
  const video = findVideo();
  if (!video) throw new Error("Aucune vidéo dans input/ (video.mp4/.mov/.mkv/.webm).");
  const info = probeVideo(video);
  console.log(`Vidéo ${video}: ${info.width}x${info.height}, ${info.duration.toFixed(1)} s`);

  if (hasUsableScript()) {
    const text = readFileSync(OUT_TXT, "utf8").trim();
    const lang = detectLanguage(text);
    writeFileSync(OUT_JSON, JSON.stringify({ lang, duration: info.duration, words: evenlySpread(text, info.duration) }, null, 1));
    console.log(`content/script.txt fourni (${lang}) — transcription sautée, horaires répartis sur ${info.duration.toFixed(0)} s.`);
    return;
  }

  if (!info.hasAudio) throw new Error("La vidéo n'a pas de piste audio : rien à transcrire. Fournis content/script.txt.");
  const r = await transcribeAll(video, info.duration);
  if (r.words.length === 0) throw new Error("Aucune parole détectée dans la vidéo.");
  writeFileSync(OUT_JSON, JSON.stringify({ lang: r.lang, duration: info.duration, words: r.words }, null, 1));
  writeFileSync(OUT_TXT, r.words.map((x) => x.w).join(" ").replace(/\s+([,.;:!?؟،])/g, "$1") + "\n");
  console.log(`Transcription ${r.engine} : ${r.words.length} mots, langue ${r.lang}.`);
}

await main();
