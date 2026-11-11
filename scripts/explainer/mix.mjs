// scripts/explainer/mix.mjs — voix + effets sonores discrets + vidéo rendue → output/explainer.mp4
// Les effets sont SYNTHÉTISÉS ici (aucun fichier, aucune musique, aucun droit d'auteur) : souffle doux à chaque
// transition, impact grave à l'ouverture, petite note claire sur les chiffres et la carte de fin.
// Niveau volontairement bas (EXPLAINER_SFX = discret | normal | non). La voix est nettoyée et mise au niveau YouTube.
//   node scripts/explainer/mix.mjs <voix> [spec.json] [video.mp4] [sortie.mp4]
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from "fs";
import path from "path";

const VOICE = process.argv[2] || "input/voice.wav";
const SPEC = process.argv[3] || "content/explainer.json";
const VIDEO = process.argv[4] || "output/explainer-video.mp4";
const OUT = process.argv[5] || "output/explainer.mp4";
const MODE = (process.env.EXPLAINER_SFX || "discret").toLowerCase();
const SR = 48000;
let FX = 48000;   // fréquence de la piste d'effets (réduite pour les vidéos très longues : mémoire)

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; }; }
function add(buf, at, samples, gain) { const o = Math.round(at * FX); for (let i = 0; i < samples.length && o + i < buf.length; i++) if (o + i >= 0) buf[o + i] += samples[i] * gain; }
function whoosh(seed, dur = 0.55) {            // bruit filtré dont la couleur monte puis redescend
  const n = Math.round(dur * FX), out = new Float32Array(n), r = rng(seed); let lp = 0, bp = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n, env = Math.pow(Math.sin(Math.PI * p), 2.2), fc = 350 + 2600 * Math.pow(Math.sin(Math.PI * Math.min(1, p * 1.15)), 2);
    const f = 2 * Math.sin((Math.PI * fc) / FX), hp = r() - lp - 0.9 * bp; bp += f * hp; lp += f * bp;
    out[i] = bp * env * 0.9;
  }
  return out;
}
function boom(dur = 1.1) {                      // impact grave et court
  const n = Math.round(dur * FX), out = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / FX, f = 46 + 70 * Math.exp(-t * 9); ph += (2 * Math.PI * f) / FX; out[i] = Math.sin(ph) * Math.exp(-t * 4.2) * Math.min(1, t * 400); }
  return out;
}
function chime(base = 880, dur = 1.2) {         // note claire, deux harmoniques
  const n = Math.round(dur * FX), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / FX, a = Math.min(1, t * 300); out[i] = a * (Math.sin(2 * Math.PI * base * t) * Math.exp(-t * 5) * 0.6 + Math.sin(2 * Math.PI * base * 1.5 * t) * Math.exp(-t * 6.5) * 0.3 + Math.sin(2 * Math.PI * base * 2 * t) * Math.exp(-t * 9) * 0.12); }
  return out;
}
function wav(buf, file) {
  const n = buf.length, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(FX, 24); b.writeUInt32LE(FX * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}

function main() {
  for (const f of [VOICE, SPEC, VIDEO]) if (!existsSync(f)) throw new Error(`${f} introuvable`);
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const total = spec.duration, g = MODE === "non" ? 0 : MODE === "normal" ? 0.055 : 0.028;    // ≈ −31 dB en « discret » : très doux (public 50 ans et plus)
  mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT.replace(/\.mp4$/i, ""), sfx = `${tmp}-sfx.wav`, buf = new Float32Array(Math.ceil((total + 0.5) * (FX = total > 2400 ? 24000 : 48000)));
  if (g) {
    add(buf, 0, boom(), g * 2.2);
    spec.scenes.forEach((s, i) => {
      if (i > 0 && !s.offset) add(buf, s.t0 - 0.08, whoosh(spec.seed * 7 + i, 0.5), g * 1.6);
      if (s.type === "stat") add(buf, s.t0 + 0.45, chime(784), g * 0.9);
      if (s.type === "outro") { add(buf, s.t0 + 0.15, chime(659, 1.6), g); add(buf, s.t0 + 0.45, chime(988, 1.6), g * 0.8); }
    });
  }
  wav(buf, sfx);
  // voix : coupe-bas (souffle, chocs de micro), niveau YouTube (−16 LUFS)
  const voice = Number(spec.voice || total), norm = `${tmp}-voice.wav`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", VOICE, "-af", `aresample=${SR},aformat=channel_layouts=mono,highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${SR}`, "-c:a", "pcm_s16le", norm]);
  // vidéos « à écouter » : la voix est découpée autour d'elles (elle attend pendant la vidéo, puis reprend)
  const cuts = (Array.isArray(spec.cuts) ? spec.cuts : []).filter((c) => c.dur > 0).sort((a, b) => a.voiceAt - b.voiceAt);
  const ins = ["-i", norm, "-i", sfx, "-i", VIDEO], parts = [], labels = [];
  let a = 0, shift = 0; const segs = [];
  for (const c of cuts) { const b = Math.min(voice, Math.max(a, c.voiceAt)); if (b - a > 0.02) segs.push({ a, b, at: a + shift }); a = b; shift += c.dur; }
  if (voice - a > 0.02) segs.push({ a, b: voice, at: a + shift });
  parts.push(`[0:a]asplit=${segs.length}${segs.map((_, i) => `[v${i}]`).join("")}`);
  segs.forEach((g, i) => { const d = g.b - g.a, f = Math.min(0.2, d / 3);
    parts.push(`[v${i}]atrim=${g.a.toFixed(3)}:${g.b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${(d - f).toFixed(3)}:d=${f.toFixed(3)},adelay=${Math.round(g.at * 1000)}:all=1[w${i}]`); labels.push(`[w${i}]`); });
  let n = 3;
  for (const c of cuts) {
    if (!c.audio || !c.file || !existsSync(c.file)) continue;
    ins.push("-i", c.file); const f = Math.min(0.3, c.dur / 4);
    parts.push(`[${n}:a:0]atrim=0:${c.dur.toFixed(3)},asetpts=PTS-STARTPTS,aresample=${SR},aformat=channel_layouts=mono,loudnorm=I=-17:TP=-1.5:LRA=11,aresample=${SR},afade=t=in:d=0.12,afade=t=out:st=${(c.dur - f).toFixed(3)}:d=${f.toFixed(3)},adelay=${Math.round(c.at * 1000)}:all=1[c${n}]`);
    labels.push(`[c${n}]`); n++;
  }
  parts.push(`[1:a]aresample=${SR}[s]`); labels.push("[s]");
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95,aformat=channel_layouts=stereo[a]`);
  execFileSync("ffmpeg", ["-y", "-v", "error", ...ins, "-filter_complex", parts.join(";"), "-map", "2:v:0", "-map", "[a]", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SR), "-t", total.toFixed(3), "-movflags", "+faststart",
    "-metadata", `comment=push-overlay;explainer;theme=${spec.themeCode || ""};langue=${spec.lang}`, OUT], { stdio: ["ignore", "inherit", "inherit"] });
  for (const f of [sfx, norm]) rmSync(f, { force: true });
  // contrôle final : image + son présents, durée conforme
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", OUT]).toString());
  const v = j.streams.find((x) => x.codec_type === "video"), au = j.streams.find((x) => x.codec_type === "audio"), d = Number(j.format.duration);
  if (!v || !au || Math.abs(d - total) > 0.5) throw new Error(`vidéo finale incohérente (image ${!!v}, son ${!!au}, ${d.toFixed(1)} s au lieu de ${total.toFixed(1)} s)`);
  console.log(`✔ ${OUT} — ${v.width}x${v.height}, ${d.toFixed(1)} s, ${(statSync(OUT).size / 1e6).toFixed(1)} Mo, effets sonores : ${MODE}`);
}
try { main(); } catch (e) { console.error("❌ " + e.message); process.exit(1); }
