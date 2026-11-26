// War Room — après usage : supprime DÉFINITIVEMENT les sons du téléphone qui ont été écoutés (et les périmés), puis la release
// temporaire « out-ecoute-telephone » et son tag dès qu'elle ne contient plus aucun son. Un son déposé pendant la War Room (pas encore
// écouté) est gardé pour la prochaine fois. Ne touche à AUCUNE autre release.
import { readFileSync, existsSync } from "fs";

const repo = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN;
const P = "output/warroom/ecoute/plan.json";
if (!repo || !token || !existsSync(P)) { console.log("nettoyage : rien à faire"); process.exit(0); }
const { telephone } = JSON.parse(readFileSync(P, "utf8"));
if (!telephone || telephone.tag !== "out-ecoute-telephone") { console.log("nettoyage : rien à faire"); process.exit(0); }
const h = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "warroom" };
const api = (u, o = {}) => fetch(`https://api.github.com/repos/${repo}${u}`, { headers: h, signal: AbortSignal.timeout(30000), ...o });

let n = 0;
for (const id of new Set(telephone.supprimer || [])) { const r = await api(`/releases/assets/${id}`, { method: "DELETE" }); if (r.ok || r.status === 404) n++; }
console.log(`nettoyage : ${n} fichier(s) du téléphone supprimé(s) définitivement`);
const r = await api(`/releases/tags/${telephone.tag}`);
if (!r.ok) process.exit(0);
const rel = await r.json();
const reste = (rel.assets || []).filter((a) => /^yt-/.test(a.name));
const enCours = (rel.assets || []).find((a) => a.name === "en-cours.txt" && Date.now() - Date.parse(a.updated_at) < 3 * 3600e3);
if (enCours) { console.log("nettoyage : le téléphone est en train de déposer des sons → release gardée (vidée au prochain passage de la War Room)"); process.exit(0); }
if (reste.length) { console.log(`nettoyage : ${reste.length} fichier(s) arrivé(s) pendant la War Room gardé(s) pour la prochaine fois`); process.exit(0); }
await api(`/releases/${rel.id}`, { method: "DELETE" });
await api(`/git/refs/tags/${telephone.tag}`, { method: "DELETE" });
console.log("nettoyage : release temporaire du téléphone et son tag supprimés définitivement");
