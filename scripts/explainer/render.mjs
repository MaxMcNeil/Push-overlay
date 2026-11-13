// scripts/explainer/render.mjs — rend content/explainer.json en vidéo (sans son) : output/explainer-video.mp4
// Chrome « headless » dessine chaque image du gabarit templates/explainer/index.html (moteur déterministe : seek(t)),
// ffmpeg encode. AUCUNE dépendance npm : pilotage de Chrome par son protocole (WebSocket natif de Node 22).
// Plusieurs Chrome en parallèle (un par cœur), chacun sa tranche ; une tranche qui échoue est refaite seule.
//   node scripts/explainer/render.mjs [spec.json] [sortie.mp4]
import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, mkdtempSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const SPEC = process.argv[2] || "content/explainer.json";
const OUT = process.argv[3] || "output/explainer-video.mp4";
const TPL = path.resolve("templates/explainer/index.html");
const WORKERS = Math.max(1, Math.min(Number(process.env.EXPLAINER_WORKERS) || os.cpus().length, 6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium", "/opt/google/chrome/chrome"].filter(Boolean);
  const f = c.find((p) => existsSync(p));
  if (!f) throw new Error("Chrome introuvable (ni google-chrome ni chromium). Sur GitHub Actions ubuntu-24.04 il est préinstallé.");
  return f;
}

export class Chrome {
  async start(w, h) {
    this.dir = mkdtempSync(path.join(os.tmpdir(), "expl-"));
    this.p = spawn(chromePath(), ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio", "--no-first-run",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-extensions", "--force-color-profile=srgb",
      "--allow-file-access-from-files", "--font-render-hinting=none", "--force-device-scale-factor=1", `--window-size=${w},${h}`,
      `--user-data-dir=${this.dir}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const url = await new Promise((res, rej) => {
      let buf = ""; const to = setTimeout(() => rej(new Error("Chrome ne démarre pas (40 s)")), 40000);
      this.p.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } });
      this.p.on("exit", (c) => { clearTimeout(to); rej(new Error(`Chrome s'est arrêté (code ${c}) : ${buf.slice(-300)}`)); });
    });
    this.ws = new WebSocket(url); this.id = 0; this.wait = new Map();
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("connexion à Chrome impossible")); });
    this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const w8 = this.wait.get(m.id); if (!w8) return; this.wait.delete(m.id); m.error ? w8.rej(new Error(m.error.message)) : w8.res(m.result); };
    this.ws.onclose = () => { for (const w8 of this.wait.values()) w8.rej(new Error("Chrome a fermé la connexion")); this.wait.clear(); };
    const { targetInfos } = await this.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    this.sid = sessionId;
    await this.send("Page.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    return this;
  }
  send(method, params = {}, timeout = 120000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.wait.delete(id); rej(new Error(`Chrome ne répond pas (${method})`)); }, timeout);
      this.wait.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(this.sid ? { sessionId: this.sid } : {}) }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("gabarit : " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
    return r.result.value;
  }
  async open(spec) {
    await this.send("Page.navigate", { url: pathToFileURL(TPL).href });
    for (let i = 0; i < 200; i++) { if (await this.eval("typeof window.init==='function'&&document.readyState==='complete'")) break; await sleep(50); }
    return this.eval(`init(${JSON.stringify(spec)})`);
  }
  async frame(t) {
    await this.eval(`seek(${t.toFixed(5)})`);
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 96, optimizeForSpeed: true });
    return Buffer.from(r.data, "base64");
  }
  stop() { try { this.ws?.close(); } catch {} try { this.p?.kill("SIGKILL"); } catch {} try { rmSync(this.dir, { recursive: true, force: true }); } catch {} }
}

function encoder(file, fps, w, h, crf, maxK) {
  const mk = Math.round(maxK || (10000 * w * h) / (1080 * 1920));
  const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "-",
    "-vf", `scale=${w}:${h}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", process.env.EXPLAINER_PRESET || "medium", "-crf", String(crf), "-maxrate", `${mk}k`, "-bufsize", `${mk * 2}k`, "-g", String(fps * 2),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", "-r", String(fps), file], { stdio: ["pipe", "ignore", "pipe"] });
  let err = ""; ff.stderr.on("data", (d) => { err += d; });
  ff.stdin.on("error", () => {});
  const done = new Promise((res, rej) => ff.on("exit", (c) => (c === 0 ? res() : rej(new Error("ffmpeg : " + err.slice(-300))))));
  return { write: (b) => new Promise((r) => (ff.stdin.write(b) ? r() : ff.stdin.once("drain", r))), end: () => { ff.stdin.end(); return done; } };
}

// chemins du plan (relatifs au dépôt) → adresses file:// de CETTE machine
const url = (p) => (p && !/^[a-z][a-z0-9+.-]*:/i.test(p) ? pathToFileURL(path.resolve(p)).href : p);
export function localize(spec) {
  const s = JSON.parse(JSON.stringify(spec)); s.logo = url(s.logo);
  for (const sc of s.scenes) { const d = sc.data || {}; if (d.photo) d.photo = url(d.photo); if (d.image) d.image = url(d.image);
    for (const m of d.media || []) { if (m.image) m.image = url(m.image); if (m.dir) { m._dir = m.dir; m.dir = url(m.dir); } } }
  return s;
}
// Images des vidéos à monter : extraites ici, une seule fois, uniquement pour les vidéos visibles dans la tranche rendue.
// L'image exacte de chaque instant est ensuite affichée par le gabarit (synchro parfaite, rendu identique d'une machine à l'autre).
export function ensureFrames(spec) {
  const seen = new Map();
  for (const sc of spec.scenes) for (const m of (sc.data && sc.data.media) || []) {
    if (m.kind !== "vid" || !m.src || !m._dir) continue;
    if (!seen.has(m._dir)) {
      const out = path.resolve(m._dir);
      let n = existsSync(out) ? readdirSync(out).filter((x) => x.endsWith(".jpg")).length : 0;
      if (!n) {
        if (!existsSync(m.src)) throw new Error(`vidéo absente : ${m.src}`);
        rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
        const side = m.side || 960;
        // -ss APRÈS -i : précis à l'image près (le passage commence exactement où le son commence)
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", m.src, ...(m.ss ? ["-ss", String(m.ss)] : []), "-t", String(m.max || 20), "-an", "-vf", `fps=30,scale='if(gte(iw,ih),min(${side},iw),-2)':'if(gte(iw,ih),-2,min(${side},ih))'`, "-q:v", "4", path.join(out, "%05d.jpg")], { stdio: ["ignore", "ignore", "inherit"] });
        n = readdirSync(out).filter((x) => x.endsWith(".jpg")).length;
        if (!n) throw new Error(`aucune image extraite de ${m.src} (à partir de ${m.ss || 0} s)`);
        console.log(`  ${path.basename(m.src)}${m.ss ? ` à partir de ${m.ss} s` : ""} : ${n} images`);
      }
      seen.set(m._dir, n);
    }
    m.n = seen.get(m._dir);
  }
}
// seules les scènes visibles dans la tranche sont chargées (une vidéo d'une heure a des centaines de scènes)
const slice = (spec, f0, f1) => ({ ...spec, scenes: spec.scenes.filter((sc) => sc.t1 > f0 / spec.fps - 1.5 && sc.t0 < f1 / spec.fps + 1.5) });

async function renderPart(full, i, f0, f1, file, onFrame) {
  const spec = slice(full, f0, f1), { w, h, fps } = spec;
  const ch = new Chrome();
  try {
    await ch.start(w, h);
    const info = await ch.open(spec);
    const enc = encoder(file, fps, w, h, spec.crf ?? 19, spec.maxrateK);
    for (let f = f0; f < f1; f++) { await enc.write(await ch.frame(f / fps)); onFrame(); }
    await enc.end();
    return info;
  } finally { ch.stop(); }
}

export async function render(raw, out, F0 = 0, F1 = Infinity) {
  mkdirSync(path.dirname(out), { recursive: true });
  const spec = localize(raw), fps = spec.fps, ALL = Math.max(1, Math.round(spec.duration * fps));
  const A = Math.max(0, Math.min(ALL - 1, Math.round(F0) || 0)), B = Math.max(A + 1, Math.min(ALL, isFinite(F1) ? Math.round(F1) : ALL)), N = B - A;
  ensureFrames(slice(spec, A, B));
  const n = Math.min(WORKERS, Math.max(1, Math.floor(N / (fps * 4))));     // pas de tranche plus courte que 4 s
  const tmp = mkdtempSync(path.join(os.tmpdir(), "expl-parts-"));
  const t0 = Date.now(); let done = 0, lastLog = 0, info = null;
  const tick = () => { done++; const now = Date.now(); if (now - lastLog > 15000) { lastLog = now; const el = (now - t0) / 1000; console.log(`  rendu ${done}/${N} images (${(done / el).toFixed(1)} img/s, reste ≈ ${Math.round((N - done) / (done / el))} s)`); } };
  console.log(`Rendu ${spec.w}x${spec.h} @${fps} — images ${A} à ${B - 1} (${N}), ${n} Chrome en parallèle`);
  const parts = [];
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    const f0 = A + Math.floor((N * i) / n), f1 = A + Math.floor((N * (i + 1)) / n), file = path.join(tmp, `p${String(i).padStart(2, "0")}.mp4`);
    parts[i] = file;
    for (let attempt = 1; ; attempt++) {
      const before = done;
      try { const r = await renderPart(spec, i, f0, f1, file, tick); if (i === 0) info = r; return; }
      catch (e) { done = before; if (attempt >= 3) throw new Error(`tranche ${i + 1}/${n} : ${e.message}`); console.log(`  ⚠ tranche ${i + 1}/${n} à refaire (${e.message.slice(0, 140)})`); await sleep(1500 * attempt); }
    }
  }));
  const list = path.join(tmp, "list.txt");
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  rmSync(tmp, { recursive: true, force: true });
  // contrôle : la vidéo doit exister, avoir la bonne taille et la bonne durée
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets", "-of", "json", out]).toString()).streams[0];
  if (pr.width !== spec.w || pr.height !== spec.h || Math.abs(Number(pr.nb_read_packets) - N) > 2) throw new Error(`vidéo rendue incohérente (${pr.width}x${pr.height}, ${pr.nb_read_packets}/${N} images)`);
  console.log(`✔ ${out} — ${N} images en ${((Date.now() - t0) / 1000).toFixed(0)} s (${(statSync(out).size / 1e6).toFixed(1)} Mo)`);
  return info;
}

/** Une seule image (aperçus, tests). */
export async function still(raw, times, dir) {
  mkdirSync(dir, { recursive: true }); const spec = localize(raw); ensureFrames(spec);
  const ch = new Chrome();
  try {
    await ch.start(spec.w, spec.h); const info = await ch.open(spec);
    for (const t of times) writeFileSync(path.join(dir, `t${t.toFixed(2).padStart(7, "0")}.jpg`), await ch.frame(t));
    return info;
  } finally { ch.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const stills = process.env.STILLS;
  (stills ? still(spec, stills.split(",").map(Number), process.env.STILLS_DIR || "output/stills") : render(spec, OUT, Number(process.env.EXPLAINER_F0 || 0), process.env.EXPLAINER_F1 ? Number(process.env.EXPLAINER_F1) : Infinity))
    .then((info) => { if (info) console.log("scènes :", info.scenes.map((s) => `${s.type}/${s.tr}${s.fit < 1 ? `(réduit ${Math.round(s.fit * 100)}%)` : ""}`).join(" · ")); })
    .catch((e) => { console.error("❌ " + e.message); process.exit(1); });
}
