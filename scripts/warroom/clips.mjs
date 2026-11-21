// scripts/warroom/clips.mjs — WAR ROOM DU JOUR, étape 5 : les ÉCRANS pour OBS.
//   wr-00.mp4 (ouverture), wr-01.mp4 … wr-NN.mp4 (un par dossier), wr-fin.mp4 (clôture) : boucles PARFAITES de P secondes
//   (OBS les répète tant que tu parles) ; alerte.webm : transition « ALERTE » à fond transparent (jouée par-dessus à
//   chaque changement de dossier). Rendu par Chrome (même moteur que Faceless), encodage H.264 (léger pour un vieux PC).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
process.env.EXPLAINER_TEMPLATE = "templates/warroom/index.html";        // AVANT de charger le moteur de rendu
const { render, Chrome } = await import("../explainer/render.mjs");
import { channelFor } from "../lib/channel.mjs";

const OUT = "output/warroom";
const P = Number(process.env.WARROOM_BOUCLE_S || 20);
const spec = JSON.parse(readFileSync(`${OUT}/warroom.json`, "utf8"));
const dossiers = spec.segments.filter((s) => s.type === "dossier");
const total = dossiers.length;
let logo = null;
try { const ch = channelFor("fr"); if (ch.logo && existsSync(ch.logo)) logo = path.resolve(ch.logo); } catch {}
const base = { w: 1080, h: 1920, fps: 30, duration: P, scenes: [], crf: 20, maxrateK: 6000, ...(logo ? { logo } : {}) };
const cats = {}; for (const d of dossiers) cats[d.categorie] = (cats[d.categorie] || 0) + 1;
const resume = `${total} DOSSIERS · ` + Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${c}`).join(" · ");
// bandeau du bas : le titre du dossier SUIVANT (fixe, lisible) ; le dernier annonce la fin sans la dévoiler
const suivant = (i) => (i < dossiers.length ? dossiers[i].titre : "Le mot de la fin");
const ecrans = [
  ["wr-00", { type: "ouverture", total, resume, suivant: suivant(0) }],
  ...dossiers.map((d, i) => [`wr-${String(d.n).padStart(2, "0")}`, { ...d, total, suivant: suivant(i + 1) }]),
  ["wr-fin", { type: "cloture", total }],
];
mkdirSync(`${OUT}/ecrans`, { recursive: true });
for (const [nom, seg] of ecrans) {
  const f = `${OUT}/ecrans/${nom}.mp4`;
  await render({ ...base, seg }, f);
  console.log(`  ✓ ${nom}.mp4 ${seg.type === "dossier" ? `— ${seg.titre}` : `(${seg.type})`}`);
}
// transition « ALERTE » : images PNG transparentes → WebM VP9 avec transparence (OBS la lit avec son alpha)
{
  const D = 1.2, fps = 30, dir = `${OUT}/alerte-png`;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const ch = new Chrome();
  try {
    await ch.start(1080, 1920);
    await ch.send("Page.navigate", { url: "file://" + path.resolve("templates/warroom/alerte.html") });
    for (let i = 0; i < 100; i++) { if (await ch.eval("typeof window.init==='function'&&document.readyState==='complete'")) break; await new Promise((r) => setTimeout(r, 50)); }
    await ch.eval(`init(${JSON.stringify({ duration: D })})`);
    await ch.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (let k = 0; k < Math.round(D * fps); k++) {
      await ch.eval(`seek(${(k / fps).toFixed(4)})`);
      const r = await ch.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${dir}/${String(k).padStart(4, "0")}.png`, Buffer.from(r.data, "base64"));
    }
  } finally { ch.stop(); }
  execFileSync("ffmpeg", ["-y", "-v", "error", "-framerate", String(fps), "-i", `${dir}/%04d.png`, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "2M", "-auto-alt-ref", "0", `${OUT}/ecrans/alerte.webm`]);
  rmSync(dir, { recursive: true, force: true });
  console.log("  ✓ alerte.webm (transition, fond transparent)");
}
console.log(`Écrans prêts : ${readdirSync(`${OUT}/ecrans`).length} fichiers`);
