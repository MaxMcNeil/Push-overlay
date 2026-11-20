// scripts/lib/llm.mjs — appels aux IA en ligne avec PLUSIEURS clés et repli automatique.
//
// Clés acceptées (secrets GitHub) — une ou plusieurs, séparées par virgule, espace ou retour à la ligne :
//   GEMINI_API_KEYS ou GEMINI_API_KEY   (Google AI Studio, gratuit ; 1 clé = 1 projet Google pour avoir 1 quota par clé)
//   GROQ_API_KEYS   ou GROQ_API_KEY     (console.groq.com, gratuit)
//   ANTHROPIC_API_KEY                   (payant, optionnel)
// Stratégie : pour chaque modèle Gemini (du meilleur au plus léger), on essaie chaque clé ; une clé saturée (429)
// ou refusée (400/403, et confirmée invalide par une vérification chez Google) est mise de côté et on passe à la suivante, sans longues pauses inutiles.
// Les clés n'apparaissent jamais dans les logs (seulement « clé 2/5 »).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// pause « avec jitter » : +0 à 25 % au hasard, pour que des appels en parallèle ne réessaient pas tous à la même seconde
const jitter = (ms) => sleep(ms + Math.random() * ms * 0.25);
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";

export function keysOf(...names) {
  const all = names.flatMap((n) => String(process.env[n] || "").split(/[\s,;]+/)).map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)];
}
export const geminiKeys = () => keysOf("GEMINI_API_KEYS", "GEMINI_API_KEY", "GEMINI_API_KEYS_PLUS");
export const groqKeys = () => keysOf("GROQ_API_KEYS", "GROQ_API_KEY", "GROQ_API_KEYS_PLUS");
export const hasAnyLLM = () => geminiKeys().length + groqKeys().length + (process.env.ANTHROPIC_API_KEY ? 1 : 0) > 0;

// départ décalé (jobs parallèles : chaque job commence par une clé différente)
function rotate(arr, offset = Number(process.env.KEY_OFFSET || 0)) {
  if (!arr.length) return arr;
  const o = ((offset % arr.length) + arr.length) % arr.length;
  return [...arr.slice(o), ...arr.slice(0, o)];
}

const modelCache = new Map();
// MÉMOIRE DE SANTÉ des modèles Gemini pendant TOUT le processus : le dernier modèle qui a répondu est essayé en premier
// aux appels suivants ; un modèle surchargé (503) ou au quota (429) est mis de côté quelques minutes au lieu d'être
// re-sollicité à chaque appel (chaque essai raté consomme du quota par minute et du temps).
const health = { good: null, cool: new Map() };
const cooled = (m) => (health.cool.get(m) || 0) > Date.now();
const coolDown = (m, ms) => health.cool.set(m, Math.max(health.cool.get(m) || 0, Date.now() + ms));
async function geminiModels(key) {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (modelCache.has("list")) return modelCache.get("list");
  // "gemini-flash-latest" suit le dernier Flash ; on ajoute les Flash listés par l'API (aucun nom ancien codé en dur),
  // puis les "flash-lite" (quota gratuit plus large) en dernier recours.
  const out = ["gemini-flash-latest"];
  const lite = [];
  try {
    const r = await fetch(`${GEMINI_BASE}/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const ver = (n) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0])[0]);
      const names = ((await r.json()).models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => /flash/.test(n) && !/(image|tts|live|audio|embedding|robotics|computer|thinking-exp)/.test(n))
        .sort((x, y) => ver(y) - ver(x) || (/preview/.test(x) ? 1 : 0) - (/preview/.test(y) ? 1 : 0));
      out.push(...names.filter((n) => !/lite/.test(n)).slice(0, 4));
      lite.push(...names.filter((n) => /lite/.test(n)).slice(0, 2));
    }
  } catch {}
  const list = [...new Set([...out, "gemini-flash-lite-latest", ...lite])];
  modelCache.set("list", list);
  return list;
}

// Une clé n'est déclarée morte qu'après VÉRIFICATION auprès de Google (liste des modèles avec cette clé) :
// un 400/403 peut viser UN modèle (préversion, région, option refusée) alors que la clé est bonne.
const keyCheck = new Map();
export async function geminiKeyOk(key) {
  if (!keyCheck.has(key)) {
    keyCheck.set(key, (async () => {
      try {
        const r = await fetch(`${GEMINI_BASE}/v1beta/models?pageSize=1`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20000) });
        return ![400, 401, 403].includes(r.status);
      } catch { return true; } // vérification impossible : on ne condamne pas la clé sur un doute
    })());
  }
  return keyCheck.get(key);
}

/** Gemini : renvoie le texte. ctx.audio = part inlineData facultative ; ctx.parts = autres parts (images) facultatives. */
export async function callGemini(sys, user, ctx = {}) {
  try { return await callGemini0(sys, user, ctx); }
  catch (e) {
    // TOUS les modèles surchargés ou trop lents chez Google (passager) : une pause, puis un dernier tour — au lieu de
    // basculer tout de suite sur une IA moins bonne ou sur le repli sans IA. Jamais pour un quota du jour ni une clé morte.
    const left = ctx.deadline ? ctx.deadline - Date.now() : Infinity;
    if (ctx._patience || left < 150000 || !/surcharg|trop lent|délai|timeout|aborted|aucun modèle Gemini disponible|50[03]/i.test(e.message)) throw e;
    console.log("  Gemini : tous les modèles surchargés pour l'instant → pause 60 s, puis nouvel essai");
    await jitter(60000);
    for (const [m, t] of health.cool) if (t - Date.now() < 6 * 60 * 1000) health.cool.delete(m);   // seulement les pauses courtes
    return callGemini0(sys, user, { ...ctx, _patience: true });
  }
}

async function callGemini0(sys, user, ctx = {}) {
  const keys = rotate(geminiKeys());
  if (!keys.length) throw new Error("aucune clé Gemini");
  const models = await geminiModels(keys[0]);
  const dead = new Set(); // clés refusées (400/403) : inutile de les réessayer
  let lastErr = new Error("aucun modèle Gemini disponible");
  let timeouts = 0;
  // BUDGET DE TEMPS : ctx.deadline (horodatage ms). Jamais d'appel qui dépasse le budget global de l'étape :
  // au-delà, on rend la main (fournisseur suivant ou repli) au lieu de bloquer le workflow jusqu'à son délai maximal.
  const left = () => (ctx.deadline ? ctx.deadline - Date.now() : Infinity);
  let thinking = ctx.thinking; // budget de « réflexion » limité = réponses bien plus rapides
  let preferLite = false; // après un délai dépassé : seulement les modèles « lite », bien plus rapides
  const avail = models.filter((m) => !cooled(m));
  const order = [...new Set([...(health.good && avail.includes(health.good) ? [health.good] : []), ...avail, ...models.filter(cooled)])];
  modelLoop: for (const m of order) {
    if (preferLite && !/lite/.test(m)) continue;
    if (cooled(m) && order.some((x) => !cooled(x) && x !== m && (!preferLite || /lite/.test(x)))) continue;
    let over = 0;
    for (let round = 0; round < 2; round++) {
      let saturated = 0;
      for (let ki = 0; ki < keys.length; ki++) {
        if (dead.has(ki)) continue;
        const tag = `Gemini ${m} (clé ${ki + 1}/${keys.length})`;
        if (left() < 25000) throw new Error(`budget de temps épuisé (dernière erreur : ${lastErr.message})`);
        const tmo = Math.max(15000, Math.min(ctx.timeoutMs || 4 * 60 * 1000, left() - 5000));
        try {
          const res = await fetch(`${GEMINI_BASE}/v1beta/models/${m}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": keys[ki] },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: sys }] },
              contents: [{ role: "user", parts: [...(ctx.audio ? [ctx.audio] : []), ...(Array.isArray(ctx.parts) ? ctx.parts : []), { text: user }] }],
              generationConfig: { temperature: ctx.temperature ?? 0.7, responseMimeType: ctx.json === false ? "text/plain" : "application/json", maxOutputTokens: ctx.maxTokens || 8192,
                ...(thinking !== undefined ? { thinkingConfig: { thinkingBudget: thinking } } : {}) },
            }),
            signal: AbortSignal.timeout(tmo),
          });
          if (res.status === 503 || res.status === 500) {
            // 503/500 = MODÈLE surchargé chez Google (pas la clé) : 2 de suite → modèle suivant, sans attendre
            over++;
            console.log(`  ${tag} : modèle surchargé (${res.status})${over >= 2 ? " → modèle suivant" : " → nouvel essai"}`);
            if (over >= 2) { over = 0; coolDown(m, 4 * 60 * 1000); continue modelLoop; }
            await jitter(2500);          // courte pause avant le 2e essai (laisser respirer le modèle)
            continue;
          }
          if (res.status === 429) {
            saturated++;
            const body = (await res.text().catch(() => "")).replace(/\s+/g, " ");
            const perDay = /PerDay|per day|daily/i.test(body), retry = Number((body.match(/retryDelay"?\s*:\s*"?(\d+)/) || [])[1]) || 60;
            console.log(`  ${tag} : quota atteint (429, ${perDay ? "quota du JOUR de ce modèle" : `quota par minute, ${retry} s`})${(body.match(/quotaId"?\s*:\s*"([^"]+)/) || [])[1] ? ` [${body.match(/quotaId"?\s*:\s*"([^"]+)/)[1]}]` : ""} → ${ki + 1 < keys.length ? "clé suivante" : "modèle suivant"}`);
            if (saturated >= keys.length - dead.size) { coolDown(m, perDay ? 12 * 3600 * 1000 : (retry + 5) * 1000); continue modelLoop; }
            continue;
          }
          if (res.status === 404) { lastErr = new Error(`${tag} : modèle introuvable`); break; }
          if (!res.ok) {
            const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
            if (res.status === 400 && /thinking/i.test(body) && thinking !== undefined) { // modèle sans réglage de réflexion
              console.log(`  ${tag} : réglage « thinking » refusé → sans`); thinking = undefined; ki--; continue;
            }
            if (res.status === 400 && /audio|inline|payload|size|token/i.test(body) && ctx.audio) {
              // requête trop lourde avec l'audio : on retente sans audio
              console.log(`  ${tag} : audio refusé (${body.slice(0, 120)}) → sans audio`);
              ctx = { ...ctx, audio: null }; ki--; continue;
            }
            // 400 qui n'est PAS un problème de clé (requête refusée par CE modèle : image, réglage…) : la clé reste bonne,
            // on essaie le modèle suivant au lieu de déclarer la clé morte pour tout le run
            if (res.status === 400 && !/API.?key|API_KEY|expired|invalid.{0,20}key|PERMISSION|billing/i.test(body)) {
              console.log(`  ${tag} : requête refusée par ce modèle (HTTP 400 : ${body.replace(/^\{ ?"error": ?\{ ?"code": ?400, ?"message": ?/, "").slice(0, 220)}) → modèle suivant`);
              lastErr = new Error(`${tag} : HTTP 400 ${body}`);
              if (thinking !== undefined) { thinking = undefined; ki--; continue; }
              continue modelLoop;
            }
            if ((res.status === 400 || res.status === 403) && (await geminiKeyOk(keys[ki]))) {
              // la clé est valide (vérifié chez Google) : c'est CE modèle qui la refuse → modèle suivant
              console.log(`  ${tag} : modèle refusé à cette clé (HTTP ${res.status} : ${body.slice(0, 160)}) — la clé est valide → modèle suivant`);
              lastErr = new Error(`${tag} : HTTP ${res.status} ${body}`);
              continue modelLoop;
            }
            if (res.status === 400 || res.status === 403) {
              dead.add(ki);
              console.log(`  ${tag} : CLÉ REFUSÉE (HTTP ${res.status}, vérifiée chez Google). Recrée-la sur https://aistudio.google.com/apikey (« Create API key in new project »).`);
              lastErr = new Error(`${tag} : HTTP ${res.status} ${body}`);
              continue;
            }
            throw new Error(`${tag} : HTTP ${res.status} ${body}`);
          }
          const d = await res.json();
          const fin = d.candidates?.[0]?.finishReason;
          const txt = (d.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || "").join("");
          if (fin === "MAX_TOKENS") {
            // les modèles "qui réfléchissent" consomment le budget de sortie : réponse coupée → on redemande avec plus de place
            if ((ctx.maxTokens || 8192) < 60000) { console.log(`  ${tag} : réponse coupée (MAX_TOKENS) → nouvel essai avec plus de place`); ctx = { ...ctx, maxTokens: 65536 }; ki--; continue; }
            console.log(`  ${tag} : réponse coupée même avec 65 536 jetons`);
          }
          if (!txt) { lastErr = new Error(`${tag} : réponse vide (${d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || "?"})`); console.log(`  ${lastErr.message}`); continue; }
          health.good = m;
          console.log(`  Gemini : modèle utilisé = ${m} (clé ${ki + 1}/${keys.length})`);
          return txt;
        } catch (e) {
          lastErr = e;
          if (/budget de temps/.test(e.message)) throw e;
          if (e.name === "TimeoutError" || /aborted|timeout/i.test(e.message)) {
            // une requête trop longue ne dépend pas de la clé : inutile de la rejouer sur les 5 clés
            timeouts++;
            console.log(`  ${tag} : pas de réponse en ${Math.round(tmo / 1000)} s${ctx.audio ? " → on retire l'audio" : ""}${timeouts >= 2 ? " → abandon de Gemini" : " → modèle suivant"}`);
            if (timeouts >= 2) throw new Error(`Gemini trop lent (${timeouts} délais dépassés)`);
            if (ctx.audio) ctx = { ...ctx, audio: null };
            preferLite = true; coolDown(m, 3 * 60 * 1000);
            continue modelLoop;
          }
          console.log(`  ${tag} : ${e.message}`);
        }
      }
      if (dead.size >= keys.length) throw lastErr;
      // toutes les clés saturées sur ce modèle : une seule courte pause (limite par minute), puis modèle suivant
      if (saturated && round === 0) { console.log(`  ${m} : toutes les clés saturées, pause 25 s...`); await jitter(25000); continue; }
      break;
    }
  }
  throw lastErr;
}

// Groq retire régulièrement des modèles (ex. llama-3.3-70b-versatile → 404) : on lit la liste des modèles disponibles
// et on prend le meilleur modèle de texte selon un ordre de préférence, jamais un nom figé.
let groqModelCache = null;
const GROQ_PREF = [/gpt-oss-120b/, /llama-4-maverick/, /kimi-k2/, /llama-3\.3-70b/, /qwen3-32b/, /llama-4-scout/, /gpt-oss-20b/, /deepseek-r1-distill-llama-70b/, /gemma2-9b/, /llama-3\.1-8b/];
async function groqModels(key) {
  if (process.env.GROQ_MODEL) return [process.env.GROQ_MODEL];
  if (groqModelCache) return groqModelCache;
  let ids = [];
  try {
    const r = await fetch(`${GROQ_BASE}/openai/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (r.ok) ids = ((await r.json()).data || []).filter((m) => m.active !== false).map((m) => m.id)
      .filter((id) => !/whisper|tts|guard|prompt-guard|playai|distil-whisper|vision|compound/i.test(id));
  } catch {}
  const ranked = [];
  for (const re of GROQ_PREF) for (const id of ids) if (re.test(id) && !ranked.includes(id)) ranked.push(id);
  groqModelCache = (ranked.length ? ranked : ids).slice(0, 6);
  // un modèle qui accepte les GROS textes (offre gratuite, jetons/minute élevés) est toujours gardé en réserve
  for (const id of ids) if (/llama-4-scout|llama-3\.3-70b/.test(id) && !groqModelCache.includes(id)) groqModelCache.push(id);
  if (!groqModelCache.length) groqModelCache = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"];
  console.log(`  Groq : modèles disponibles retenus = ${groqModelCache.join(", ")}`);
  return groqModelCache;
}

// Capacité d'une requête (offre gratuite = jetons PAR MINUTE, réponse comprise). Valeurs de départ prudentes, puis APPRISES :
// un refus 413 dit « Limit 8000, Requested 9500 » → la vraie limite est retenue pour la suite du run.
const GROQ_CAP0 = [[/llama-4-scout/, 30000], [/llama-3\.3-70b/, 12000], [/kimi-k2/, 10000], [/gpt-oss/, 8000], [/./, 6000]];
const groqCap = new Map();
const capOf = (m) => groqCap.get(m) || GROQ_CAP0.find(([re]) => re.test(m))[1];
// estimation des jetons : ~3,5 caractères par jeton en écriture latine, ~2 en arabe
const jetons = (t) => { const s = String(t || ""), ar = (s.match(/[\u0600-\u06FF]/g) || []).length; return Math.ceil((s.length - ar) / 3.5 + ar / 2); };

export async function callGroq(sys, user, ctx = {}) {
  const keys = rotate(groqKeys());
  if (!keys.length) throw new Error("aucune clé Groq");
  const models = await groqModels(rotate(groqKeys())[0] || "");
  let noEffort = false, jsonOff = ctx.json === false;
  const besoin = jetons(sys) + jetons(user) + 300;
  const veut = Math.min(ctx.maxTokens || 4096, Number(process.env.GROQ_MAX_TOKENS || 4096));
  // choix INTELLIGENT : le meilleur modèle dont la capacité contient la demande (au moins 1 000 jetons de réponse)
  const tient = (m) => capOf(m) - besoin >= Math.min(veut, 1000);
  const large = (m) => capOf(m) - besoin >= veut;             // assez de place pour une réponse COMPLÈTE
  const ordre = [...new Set([...models.filter(large), ...models.filter(tient), ...models])];
  let mi = 0, model = ordre[0];
  const maxTok = () => Math.max(512, Math.min(veut, capOf(model) - besoin));
  let lastErr = new Error("Groq indisponible");
  for (let round = 0; round < 3; round++) {
    let wait = 0;
    for (let ki = 0; ki < keys.length; ki++) {
      const res = await fetch(`${GROQ_BASE}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keys[ki]}` },
        body: JSON.stringify({
          // l'offre gratuite compte max_tokens dans la limite par minute (≈ 12 000) : on plafonne la réponse
          model, temperature: ctx.temperature ?? 0.6, max_tokens: maxTok(),
          ...(/gpt-oss/.test(model) && !noEffort ? { reasoning_effort: "low" } : {}), // réflexion courte : la réponse garde sa place
          ...(jsonOff ? {} : { response_format: { type: "json_object" } }),
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(Math.max(15000, Math.min(ctx.timeoutMs || 3 * 60 * 1000, (ctx.deadline ? ctx.deadline - Date.now() : Infinity) - 5000))),
      }).catch((e) => ({ ok: false, status: 0, text: async () => e.message, headers: new Map() }));
      if (res.status === 429) {
        wait = Math.max(wait, Math.min(60, Number(res.headers.get("retry-after")) || 15 * (round + 1)));
        lastErr = new Error("Groq : limite de débit (429)");
        console.log(`  Groq (clé ${ki + 1}/${keys.length}) : limite atteinte → clé suivante`);
        continue;
      }
      if (res.status === 413) {
        // trop gros pour CE modèle : on retient sa vraie limite et on passe au modèle suivant qui peut le contenir
        const t = await res.text().catch(() => "");
        const lim = Number((t.match(/Limit\s*(\d+)/i) || [])[1]);
        if (lim) groqCap.set(model, lim);
        const suivants = ordre.slice(mi + 1).filter(tient);
        lastErr = new Error(`Groq ${model} : texte trop long pour l'offre gratuite (413)`);
        if (!suivants.length) throw new Error(`Groq : texte trop long pour tous les modèles gratuits (${besoin} jetons) — à découper`);
        mi = ordre.indexOf(suivants[0]); model = suivants[0];
        console.log(`  Groq : texte trop long → modèle plus large : ${model}`); ki--; continue;
      }
      if (!res.ok) {
        const full = await res.text(), body = full.slice(0, 180);
        // mode JSON strict de Groq : réponse un peu hors format refusée. Le texte produit est dans « failed_generation » :
        // on le rend (plan.mjs le répare/valide) ; sinon on redemande sans le mode strict.
        if (res.status === 400 && /json_validate_failed/.test(full)) {
          let fg = ""; try { fg = JSON.parse(full)?.error?.failed_generation || ""; } catch {}
          if (fg.length > 20) { console.log(`  Groq ${model} : JSON imparfait récupéré (sera vérifié)`); return fg; }
          if (!jsonOff) { jsonOff = true; console.log(`  Groq ${model} : JSON strict refusé → nouvel essai sans le mode strict`); ki--; continue; }
        }
        lastErr = new Error(`Groq ${model} : HTTP ${res.status} ${body}`); console.log(`  ${lastErr.message}`);
        if (res.status === 400 && /reasoning_effort/i.test(body) && !noEffort) { noEffort = true; ki--; continue; }
        if ((res.status === 404 || res.status === 400) && /model|decommission|not exist|not found/i.test(body) && mi < ordre.length - 1) {
          model = ordre[++mi]; console.log(`  Groq : modèle suivant → ${model}`); ki--; // même clé, autre modèle
        }
        continue;
      }
      const d = await res.json();
      console.log(`  Groq : modèle utilisé = ${model} (clé ${ki + 1}/${keys.length})`);
      return d.choices?.[0]?.message?.content || "";
    }
    if (!wait) break;
    console.log(`  Groq : toutes les clés limitées, pause ${wait}s...`);
    await sleep(wait * 1000);
  }
  throw lastErr;
}

export async function callClaude(sys, user, ctx = {}) {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const res = await fetch(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: ctx.maxTokens || 6000, system: sys, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(ctx.timeoutMs || 4 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Claude : HTTP ${res.status} ${(await res.text()).slice(0, 180)}`);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("");
}

/** Liste des fournisseurs configurés, dans l'ordre d'essai. */
export function providers() {
  return [
    ["gemini", geminiKeys().length, callGemini],
    ["groq", groqKeys().length, callGroq],
    ["claude", process.env.ANTHROPIC_API_KEY ? 1 : 0, callClaude],
  ].filter((x) => x[1]).map(([name, , fn]) => [name, fn]);
}

export function parseJson(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json|```/g, "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
