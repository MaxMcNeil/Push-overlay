// scripts/lib/util.mjs — petits helpers partagés (ffprobe, langue, polices, temps)
import { execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";

export const INPUT_DIR = "input";
export const CONTENT_DIR = "content";
export const OUTPUT_DIR = "output";

export function findVideo() {
  for (const ext of ["mp4", "mov", "mkv", "webm", "avi", "m4v"]) {
    const p = `${INPUT_DIR}/video.${ext}`;
    if (existsSync(p)) return p;
  }
  return null;
}

export function probeVideo(file) {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    { maxBuffer: 1 << 26 }
  ).toString();
  const j = JSON.parse(raw);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  let w = v.width, h = v.height;
  // Les vidéos de téléphone portent souvent une rotation en métadonnée :
  // ffmpeg la applique au décodage, ffprobe donne la taille "brute".
  let rot = 0;
  const sd = (v.side_data_list || []).find((x) => x.rotation !== undefined);
  if (sd) rot = Math.abs(Number(sd.rotation)) % 180;
  if (v.tags && v.tags.rotate) rot = Math.abs(Number(v.tags.rotate)) % 180;
  if (rot === 90) [w, h] = [h, w];
  let fps = 30;
  if (v.avg_frame_rate && v.avg_frame_rate.includes("/")) {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (d) fps = n / d;
  }
  if (!isFinite(fps) || fps < 10) fps = 30;
  return {
    width: w,
    height: h,
    duration: Number(j.format.duration) || Number(v.duration) || 0,
    fps: Math.min(30, Math.round(fps)),
    hasAudio: !!a,
  };
}

// Arabe / français / anglais / italien. Whisper donne déjà le code langue
// (transcript.json) ; ceci n'est qu'un filet de sécurité pour un texte brut.
export function detectLanguage(text) {
  const sample = text.slice(0, 3000);
  const ar = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  const letters = (sample.match(/\p{L}/gu) || []).length;
  if (letters && ar / letters > 0.3) return "ar";
  const low = " " + sample.toLowerCase().replace(/[^\p{L}' ]/gu, " ") + " ";
  const score = (words) => words.reduce((n, w) => n + (low.split(` ${w} `).length - 1), 0);
  const s = {
    fr: score(["le", "la", "les", "des", "est", "une", "que", "pour", "dans", "pas", "qui", "avec"]),
    en: score(["the", "and", "is", "of", "to", "that", "with", "for", "are", "this", "was", "you"]),
    it: score(["il", "che", "di", "della", "sono", "per", "con", "non", "una", "gli", "questo", "come"]),
  };
  return Object.entries(s).sort((a, b) => b[1] - a[1])[0][0];
}

export function normLang(code) {
  const c = String(code || "").toLowerCase().slice(0, 2);
  return ["ar", "fr", "en", "it"].includes(c) ? c : "fr";
}

export function fmtAssTime(sec) {
  const s = Math.max(0, sec);
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

export function listFontFiles() {
  return existsSync("fonts") ? readdirSync("fonts") : [];
}

export function wordCount(t) {
  return t.split(/\s+/).filter(Boolean).length;
}
