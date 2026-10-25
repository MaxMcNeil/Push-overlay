// scripts/lib/llm.mjs — appels aux IA en ligne avec PLUSIEURS clés et repli automatique.
//
// Clés acceptées (secrets GitHub) — une ou plusieurs, séparées par virgule, espace ou retour à la ligne :
//   GEMINI_API_KEYS ou GEMINI_API_KEY   (Google AI Studio, gratuit ; 1 clé = 1 projet Google pour avoir 1 quota par clé)
//   GROQ_API_KEYS   ou GROQ_API_KEY     (console.groq.com, gratuit)
//   ANTHROPIC_API_KEY                   (payant, optionnel)
// Stratégie : pour chaque modèle Gemini (du meilleur au plus léger), on essaie chaque clé ; une clé saturée (429)
// ou refusée (400/403) est mise de côté pour ce modèle et on passe à la suivante, sans longues pauses inutiles.
// Les clés n'apparaissent jamais dans les logs (seulement « clé 2/5 »).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";

export function keysOf(...names) {
  const all = names.flatMap((n) => String(process.env[n] || "").split(/[\s,;]+/)).map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)];
}
export const geminiKeys = () => keysOf("GEMINI_API_KEYS", "GEMINI_API_KEY");
export const groqKeys = () => keysOf("GROQ_API_KEYS", "GROQ_API_KEY");
export const hasAnyLLM = () => geminiKeys().length + groqKeys().length + (process.env.ANTHROPIC_API_KEY ? 1 : 0) > 0;

// départ décalé (jobs parallèles : chaque job commence par une clé différente)
function rotate(arr, offset = Number(process.env.KEY_OFFSET || 0)) {
  if (!arr.length) return arr;
  const o = ((offset % arr.length) + arr.length) % arr.length;
  return [...arr.slice(o), ...arr.slice(0, o)];
}

const modelCache = new Map();
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

/** Gemini : renvoie le texte. ctx.audio = part inlineData facultative. */
export async function callGemini(sys, user, ctx = {}) {
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
  modelLoop: for (const m of models) {
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
              contents: [{ role: "user", parts: [...(ctx.audio ? [ctx.audio] : []), { text: user }] }],
              generationConfig: { temperature: ctx.temperature ?? 0.7, responseMimeType: ctx.json === false ? "text/plain" : "application/json", maxOutputTokens: ctx.maxTokens || 8192,
                ...(thinking !== undefined ? { thinkingConfig: { thinkingBudget: thinking } } : {}) },
            }),
            signal: AbortSignal.timeout(tmo),
          });
          if (res.status === 429 || res.status === 503 || res.status === 500) { saturated++; console.log(`  ${tag} : saturé (${res.status}) → clé suivante`); continue; }
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
            if (res.status === 400 || res.status === 403) {
              dead.add(ki);
              console.log(`  ${tag} : CLÉ REFUSÉE (HTTP ${res.status}). Recrée-la sur https://aistudio.google.com/apikey (« Create API key in new project »).`);
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
            continue modelLoop;
          }
          console.log(`  ${tag} : ${e.message}`);
        }
      }
      if (dead.size >= keys.length) throw lastErr;
      // toutes les clés saturées sur ce modèle : une seule courte pause (limite par minute), puis modèle suivant
      if (saturated && round === 0) { console.log(`  ${m} : toutes les clés saturées, pause 25 s...`); await sleep(25000); continue; }
      break;
    }
  }
  throw lastErr;
}

export async function callGroq(sys, user, ctx = {}) {
  const keys = rotate(groqKeys());
  if (!keys.length) throw new Error("aucune clé Groq");
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  let lastErr = new Error("Groq indisponible");
  for (let round = 0; round < 3; round++) {
    let wait = 0;
    for (let ki = 0; ki < keys.length; ki++) {
      const res = await fetch(`${GROQ_BASE}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keys[ki]}` },
        body: JSON.stringify({
          // l'offre gratuite compte max_tokens dans la limite par minute (≈ 12 000) : on plafonne la réponse
          model, temperature: ctx.temperature ?? 0.6, max_tokens: Math.min(ctx.maxTokens || 4096, Number(process.env.GROQ_MAX_TOKENS || 4096)),
          ...(ctx.json === false ? {} : { response_format: { type: "json_object" } }),
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
      if (res.status === 413) throw new Error("Groq : texte trop long pour l'offre gratuite (413)");
      if (!res.ok) { lastErr = new Error(`Groq ${model} : HTTP ${res.status} ${(await res.text()).slice(0, 180)}`); console.log(`  ${lastErr.message}`); continue; }
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
