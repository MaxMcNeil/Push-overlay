// scripts/explainer/mix.mjs — voix + effets sonores discrets + vidéo rendue → output/explainer.mp4
// Les effets sont SYNTHÉTISÉS ici (aucun fichier, aucune musique, aucun droit d'auteur) : souffle doux à chaque
// transition, impact grave à l'ouverture, petite note claire sur les chiffres et la carte de fin.
// Niveau volontairement bas (EXPLAINER_SFX = discret | normal | non). La voix est nettoyée et mise au niveau YouTube.
//   node scripts/explainer/mix.mjs <voix> [spec.json] [video.mp4] [sortie.mp4]
import { execFileSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

/** RESPIRATIONS (option « respirations », atténuées par défaut) : entre deux mots (horaires de la transcription), le son
 *  restant (inspiration, bruit de bouche) est baissé de ~16 dB avec des fondus de 15 ms. La durée ne change PAS (le montage
 *  reste calé au centième). Garde-fous : rien n'est touché à moins de 40 ms après un mot ni 30 ms avant le suivant, ni
 *  autour d'un son aussi fort que la parole (mot mal horodaté) ; un creux de moins de 80 ms est laissé tel quel. */
function respirations(file) {
  const MODE_R = (process.env.EXPLAINER_RESPIRATIONS || "atténuées").toLowerCase();
  if (/gard|non|off/.test(MODE_R)) return;
  const T = process.env.EXPLAINER_TRANSCRIPT || "content/transcript.json";
  let words = [];
  try { words = (JSON.parse(readFileSync(T, "utf8")).words || []).filter((w) => isFinite(w.t0) && isFinite(w.t1) && w.t1 >= w.t0).sort((a, b) => a.t0 - b.t0); } catch {}
  if (words.length < 10) { console.log("  respirations : transcription absente, voix laissée telle quelle"); return; }
  const raw = `${file}.raw`;
  try {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "s16le", raw]);
    const b = readFileSync(raw), x = new Int16Array(b.buffer, b.byteOffset, b.length >> 1), F = SR / 100, n = Math.floor(x.length / F);
    const env = new Float32Array(n), dr = new Float32Array(n);   // dr = part des aigus (souffle, « h » d'inspiration) : haut = son non voisé
    for (let k = 0; k < n; k++) { let e = 0, d = 0; for (let q = k * F; q < (k + 1) * F; q++) { e += x[q] * x[q]; if (q) d += (x[q] - x[q - 1]) ** 2; } env[k] = Math.sqrt(e / F); dr[k] = e ? d / e : 0; }
    const speech = Float32Array.from(env).sort()[Math.floor(n * 0.7)] || 0;
    if (!speech) { rmSync(raw, { force: true }); return; }
    const loud = speech * 0.35, prot = new Uint8Array(n), cut = new Uint8Array(n);
    // protégé = son voisé aussi fort que la parole (une voyelle d'un mot mal horodaté), ou tout son presque au niveau de la parole ;
    // une inspiration (non voisée) reste atténuable même assez forte
    for (let k = 0; k < n; k++) if (env[k] > loud && (dr[k] < 0.15 || env[k] > speech * 0.9)) for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 6); j++) prot[j] = 1;
    const zone = (a, b2) => { a = Math.max(0, Math.ceil(a * 100)); b2 = Math.min(n - 1, Math.floor(b2 * 100));
      for (let k = a; k <= b2; k++) { if (prot[k]) continue; let r = k; while (r + 1 <= b2 && !prot[r + 1]) r++; if (r - k + 1 >= 8) cut.fill(1, k, r + 1); k = r; } };
    zone(0, words[0].t0 - 0.05);
    for (let i = 0; i + 1 < words.length; i++) { const a = words[i].t1 + 0.04, b2 = words[i + 1].t0 - 0.03; if (b2 - a >= 0.08) zone(a, b2); }
    zone(words[words.length - 1].t1 + 0.06, n / 100);
    const G = 0.15, step = 1 / (0.015 * SR);
    let g = 1, tot = 0;
    for (let k = 0; k < n; k++) { if (cut[k]) tot++; const tg = cut[k] ? G : 1;
      for (let q = k * F; q < (k + 1) * F; q++) { g = g < tg ? Math.min(tg, g + step) : Math.max(tg, g - step); if (g !== 1) x[q] = Math.round(x[q] * g); } }
    writeFileSync(raw, b);
    const tmpR = `${file}.resp.wav`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "s16le", "-ar", String(SR), "-ac", "1", "-i", raw, "-c:a", "pcm_s16le", tmpR]);
    renameSync(tmpR, file);
    console.log(`  respirations : ${(tot / 100).toFixed(0)} s de creux entre les mots atténués (−16 dB), durée inchangée`);
  } catch (e) { console.log(`  respirations : traitement impossible (${String(e.message).slice(0, 120)}), voix laissée telle quelle`); }
  rmSync(raw, { force: true });
}

/** Retard (s) du son traité par rapport à l'original : corrélation des enveloppes (1 ms) sur la première minute. */
function latency(a, b) {
  try {
    const rd = (f) => { const r = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-t", "60", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 26 });
      const n = Math.floor(r.length / 16), e = new Float64Array(n); for (let k = 0; k < n; k++) { let x = 0; for (let q = 0; q < 8; q++) x += Math.abs(r.readInt16LE((k * 8 + q) * 2)); e[k] = x; } return e; };
    const ea = rd(a), eb = rd(b); let best = 0, bv = -Infinity;
    for (let l = 0; l <= 150; l++) { let c = 0; const n = Math.min(ea.length, eb.length - l); for (let i = 0; i < n; i++) c += ea[i] * eb[i + l]; if (c > bv) { bv = c; best = l; } }
    return best / 1000;
  } catch { return 0; }
}

function main() {
  for (const f of [VOICE, SPEC, VIDEO]) if (!existsSync(f)) throw new Error(`${f} introuvable`);
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const total = spec.duration, g = MODE === "non" ? 0 : MODE === "normal" ? 0.055 : 0.028;    // ≈ −31 dB en « discret » : très doux (public 50 ans et plus)
  mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT.replace(/\.mp4$/i, ""), sfx = `${tmp}-sfx.wav`, buf = new Float32Array(Math.ceil((total + 0.5) * (FX = total > 2400 ? 24000 : 48000)));
  if (g) {
    if (!(spec.cuts || []).some((c) => c.opener && c.at < 0.5)) add(buf, 0, boom(), g * 2.2);   // ouverture choc : son de l'extrait seul
    spec.scenes.forEach((s, i) => {
      if (i > 0 && !s.offset) add(buf, s.t0 - 0.08, whoosh(spec.seed * 7 + i, 0.5), g * 1.6);
      if (s.type === "stat") add(buf, s.t0 + 0.45, chime(784), g * 0.9);
      if (s.type === "outro") { add(buf, s.t0 + 0.15, chime(659, 1.6), g); add(buf, s.t0 + 0.45, chime(988, 1.6), g * 0.8); }
    });
  }
  wav(buf, sfx);
  // voix : coupe-bas (souffle, chocs de micro), niveau YouTube (−16 LUFS)
  const voice = Number(spec.voice || total), norm = `${tmp}-voice.wav`;
  // « radio » (défaut) : traitement de studio d'émission — souffle réduit, grave chaleureux (profondeur), médiums boueux
  // creusés, aucune montée des aigus (voix chaude et basse), sifflantes adoucies, compression qui rapproche la voix, niveau YouTube.
  // « naturel » : simple nettoyage + niveau. Si le traitement studio échoue (ffmpeg ancien), repli automatique sur « naturel ».
  const base = `aresample=${SR},aformat=channel_layouts=mono`;
  const STYLE = (process.env.EXPLAINER_VOICE || "radio").toLowerCase();
  // VOLUME (option « volume ») : auto = mesure ta voix et la remonte si tu étais loin du micro, puis la cale exactement au
  // niveau de référence de YouTube (−14 LUFS : au-delà, YouTube baisse lui-même le son) ; fort / très fort = voix plus
  // dense et plus présente (compression plus marquée), utile si tu parles très loin ou très doucement.
  const VOL = (process.env.EXPLAINER_VOLUME || "auto").toLowerCase().replace(/\s+/g, "-");
  const target = VOL.startsWith("tr") ? -13 : VOL === "fort" ? -13.5 : -14;
  const ebu = (f) => { const r = spawnSync("ffmpeg", ["-v", "info", "-nostats", "-i", f, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 27 });
    const I = Number(String(r.stderr || "").match(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+) LUFS/)?.[1]);
    return isFinite(I) ? I : NaN; };
  const inI = ebu(VOICE);
  // voix lointaine ou très faible : gain avant le traitement (jusqu'à +30 dB) et réduction de bruit plus forte
  const far = isFinite(inI) && inI < -30;
  const pre = isFinite(inI) ? Math.max(0, Math.min(30, -20 - inI)) : 0;
  // DÉBRUITAGE (option « débruitage ») : léger = filtre classique (souffle constant) ; fort (IA) = RNNoise, réseau de
  // neurones entraîné sur la parole : enlève aussi les bruits qui varient (rue, télé, ventilateur, voix au loin).
  // Le modèle est dans le dépôt (aucun téléchargement) ; s'il manque ou si ffmpeg le refuse → filtre classique.
  const RNN = path.join(path.dirname(fileURLToPath(import.meta.url)), "rnnoise", "sh.rnnn");
  let IA = /fort|ia/i.test(process.env.EXPLAINER_DEBRUITAGE || "") && existsSync(RNN);
  const classic = far || VOL !== "auto" ? "afftdn=nr=16:nf=-50" : "afftdn=nr=10:nf=-52";
  const ia = () => `arnndn=m='${RNN.replace(/\\/g, "/").replace(/'/g, "")}':mix=0.92,afftdn=nr=4:nf=-55`;
  const nrOf = () => (IA ? ia() : classic);
  const comp = VOL.startsWith("tr") ? "acompressor=threshold=-26dB:ratio=5:attack=4:release=120:knee=6:makeup=4"
    : VOL === "fort" ? "acompressor=threshold=-24dB:ratio=4:attack=5:release=130:knee=6:makeup=4" : "acompressor=threshold=-22dB:ratio=3.5:attack=6:release=140:knee=6:makeup=3.5";
  // voix chaude et basse : graves de poitrine, « carton » retiré, AUCUNE montée des aigus (règle de la chaîne : jamais
  // un son aigu) ; le dé-esseur adoucit les « s »
  const studio = () => ["highpass=f=75", nrOf(), ...(pre ? [`volume=${pre.toFixed(1)}dB`] : []), "equalizer=f=115:t=q:w=0.9:g=3.5", "equalizer=f=290:t=q:w=1.2:g=-2.5",
    "deesser=i=0.3", comp, "alimiter=limit=0.9"].join(",");
  const natural = () => ["highpass=f=70", ...(IA ? [ia()] : far ? ["afftdn=nr=12:nf=-50"] : []), ...(pre ? [`volume=${pre.toFixed(1)}dB`] : []), ...(VOL !== "auto" ? [comp, "alimiter=limit=0.9"] : [])].join(",");
  // niveau final EXACT : loudnorm en deux passes (mesure, puis correction linéaire) — pas de « pompage » du son
  const twoPass = (chain) => {
    const r = spawnSync("ffmpeg", ["-v", "info", "-nostats", "-i", VOICE, "-af", `${base},${chain},loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 27 });
    const m = (r.stderr || "").match(/\{[^{}]*"input_i"[^{}]*\}/);
    if (!m) throw new Error("mesure du volume impossible : " + String(r.stderr || "").slice(-200));
    const j = JSON.parse(m[0]);
    const ln = isFinite(Number(j.input_i)) && Number(j.input_i) > -70
      ? `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`
      : `loudnorm=I=${target}:TP=-1.5:LRA=11`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", VOICE, "-af", `${base},${chain},${ln},aresample=${SR}`, "-c:a", "pcm_s16le", norm], { stdio: ["ignore", "ignore", "pipe"] });
  };
  let voiceStyle = STYLE === "naturel" ? "naturel" : "radio";
  const chain = () => (voiceStyle === "radio" ? studio() : natural());
  if (IA) console.log("  débruitage : fort (IA RNNoise)");
  try {
    try { twoPass(chain()); }
    catch (e) {
      if (!IA) throw e;
      console.log(`⚠ débruitage IA refusé (${String(e.stderr || e.message).trim().slice(-160)}) : débruitage classique`);
      IA = false; twoPass(chain());
    }
  }
  catch (e) { console.log(`⚠ traitement « ${voiceStyle} » impossible (${String(e.stderr || e.message).trim().slice(-160)}) : traitement simple`); voiceStyle = "simple";
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", VOICE, "-af", `${base},highpass=f=70,${pre ? `volume=${pre.toFixed(1)}dB,` : ""}loudnorm=I=${target}:TP=-1.5:LRA=11,aresample=${SR}`, "-c:a", "pcm_s16le", norm]); }
  // Certains filtres (réduction de bruit, limiteur) retardent le son de quelques dizaines de ms : mesuré ici puis
  // compensé, sinon les coupures (posées au milieu des respirations) tomberaient sur la fin des mots.
  const lag = latency(VOICE, norm);
  if (lag > 0.002) {
    const tmpA = `${tmp}-voice-aligned.wav`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", norm, "-af", `atrim=start=${lag.toFixed(4)},asetpts=PTS-STARTPTS,apad=pad_dur=${lag.toFixed(4)}`, "-c:a", "pcm_s16le", tmpA]);
    renameSync(tmpA, norm);
    console.log(`  décalage du traitement compensé : ${(lag * 1000).toFixed(0)} ms`);
  }
  respirations(norm);
  const outI = ebu(norm);
  console.log(`Voix : ${isFinite(inI) ? inI.toFixed(1) : "?"} LUFS à l'origine${far ? " (voix lointaine ou faible : remontée de " + pre.toFixed(0) + " dB)" : ""} → ${isFinite(outI) ? outI.toFixed(1) : "?"} LUFS (cible ${target}, référence YouTube −14)`);
  // vidéos « à écouter » : la voix est découpée autour d'elles (elle attend pendant la vidéo, puis reprend)
  const cuts = (Array.isArray(spec.cuts) ? spec.cuts : []).filter((c) => c.dur > 0).sort((a, b) => a.voiceAt - b.voiceAt);
  const ins = ["-i", norm, "-i", sfx, "-i", VIDEO], parts = [], labels = [];
  let a = 0, shift = 0; const segs = [];
  // fondus dans le creux de la respiration (fo = avant la coupure, fi = après) : jamais sur la fin ou le début d'un mot
  let fin = 0.04;
  for (const c of cuts) { const b = Math.min(voice, Math.max(a, c.voiceAt)); if (b - a > 0.02) segs.push({ a, b, at: a + shift, fi: fin, fo: c.fo ?? 0.05 }); a = b; shift += c.dur; fin = c.fi ?? 0.04; }
  if (voice - a > 0.02) segs.push({ a, b: voice, at: a + shift, fi: fin, fo: 0.25 });
  parts.push(`[0:a]asplit=${segs.length}${segs.map((_, i) => `[v${i}]`).join("")}`);
  segs.forEach((g, i) => { const d = g.b - g.a, f = Math.max(0.01, Math.min(g.fo, d / 3)), fi = Math.max(0.01, Math.min(g.fi, d / 3));
    parts.push(`[v${i}]atrim=${g.a.toFixed(3)}:${g.b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fi.toFixed(3)},afade=t=out:st=${(d - f).toFixed(3)}:d=${f.toFixed(3)},adelay=${Math.round(g.at * 1000)}:all=1[w${i}]`); labels.push(`[w${i}]`); });
  let n = 3;
  for (const c of cuts) {
    if (!c.audio || !c.file || !existsSync(c.file)) continue;
    ins.push("-i", c.file); const f = Math.min(0.3, c.dur / 4);
    parts.push(`[${n}:a:0]atrim=${(c.ss || 0).toFixed(3)}:${((c.ss || 0) + c.dur).toFixed(3)},asetpts=PTS-STARTPTS,aresample=${SR},aformat=channel_layouts=mono,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=${SR},afade=t=in:d=0.12,afade=t=out:st=${(c.dur - f).toFixed(3)}:d=${f.toFixed(3)},adelay=${Math.round(c.at * 1000)}:all=1[c${n}]`);
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
  console.log(`✔ ${OUT} — ${v.width}x${v.height}, ${d.toFixed(1)} s, ${(statSync(OUT).size / 1e6).toFixed(1)} Mo, voix : ${voiceStyle}, effets sonores : ${MODE}`);
}
try { main(); } catch (e) { console.error("❌ " + e.message); process.exit(1); }
