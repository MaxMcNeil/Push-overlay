// scripts/explainer/pick-voice.mjs — QUEL fichier est ta voix ? Aucun nom imposé : le workflow le détecte.
// Usage : node pick-voice.mjs fichier1 fichier2 …  → JSON { voice, why, sure, extraAudio[], ranking[] }
// Indices (cumulés) : un fichier SON (mp3, m4a, wav… ou vidéo sans image) est presque toujours ta voix ; ta voix est longue ;
// une vidéo à image fixe (écran noir, photo) est une voix ; un enregistrement d'écran de téléphone (format très allongé,
// image qui bouge) est un extrait ; un nom qui dit « voix / voice / صوت… » compte aussi, mais n'est jamais obligatoire.
import { execFileSync, spawnSync } from "child_process";
import path from "path";
import { pathToFileURL } from "url";

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|wma|amr|weba)$/i;
const NAMED = /(^|[^a-z])(voix|voice|vocal|vocale|narration|narr|audio|podcast)([^a-z]|$)|صوت|تسجيل_?صوتي|بودكاست/i;

export function probe(f) {
  try {
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { maxBuffer: 1 << 24, timeout: 60000 }).toString());
    const a = j.streams.find((s) => s.codec_type === "audio");
    const v = j.streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));   // pochette d'un mp3 ≠ vidéo
    let w = v?.width || 0, h = v?.height || 0;
    const rot = Math.abs(Number((v?.side_data_list || []).find((x) => x.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
    if (rot === 90) [w, h] = [h, w];
    return { dur: Number(j.format.duration) || Number(a?.duration) || 0, audio: !!a, video: !!v && w > 0, w, h };
  } catch { return null; }
}

/** Part de l'image figée sur les 90 premières secondes (0 à 1). */
function frozen(f, dur) {
  const t = Math.min(90, dur);
  if (t < 4) return 0;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-t", String(t), "-i", f, "-an", "-vf", "scale=160:-2,freezedetect=n=0.003:d=2", "-f", "null", "-"], { encoding: "utf8", timeout: 180000, maxBuffer: 1 << 26 });
  const log = r.stderr || "";
  const st = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1]), en = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => +m[1]);
  let tot = 0;
  st.forEach((s, i) => { tot += (en[i] ?? t) - s; });
  return Math.max(0, Math.min(1, tot / t));
}

export function score(f, p, still = null) {
  const why = [];
  let s = Math.max(1, p.dur);
  const name = path.basename(f);
  const audioOnly = !p.video || AUDIO_EXT.test(name);
  if (audioOnly) { s *= 4; why.push("fichier son"); }
  if (NAMED.test(name.toLowerCase())) { s *= 10; why.push("nom"); }
  if (!audioOnly) {
    const fz = still ?? frozen(f, p.dur);
    if (fz >= 0.8) { s *= 3; why.push("image fixe"); }
    const ar = Math.max(p.w, p.h) / Math.max(1, Math.min(p.w, p.h));
    if (ar >= 1.95) { s *= 0.3; why.push("format écran de téléphone"); }
  }
  why.push(`${Math.round(p.dur)} s`);
  return { s, why };
}

export function pick(files, opts = {}) {
  const c = [];
  for (const f of files) {
    const p = (opts.probe || probe)(f);
    if (!p || !p.audio || p.dur < 3) continue;
    const { s, why } = score(f, p, opts.still ? opts.still(f) : null);
    c.push({ f, p, s, why });
  }
  if (!c.length) return { voice: null, why: "aucun fichier avec du son (au moins 3 s)", sure: false, extraAudio: [], ranking: [] };
  c.sort((a, b) => b.s - a.s);
  const [best, second] = c;
  const sure = !second || second.s < best.s * 0.6;
  const extraAudio = c.slice(1).filter((x) => !x.p.video || AUDIO_EXT.test(path.basename(x.f))).map((x) => x.f);
  return {
    voice: best.f, sure, extraAudio,
    why: `${path.basename(best.f)} (${best.why.join(", ")})` + (second ? ` — devant ${path.basename(second.f)} (${second.why.join(", ")})` : ""),
    ranking: c.map((x) => ({ file: path.basename(x.f), score: Math.round(x.s), why: x.why.join(", ") })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(pick(process.argv.slice(2))));
}
