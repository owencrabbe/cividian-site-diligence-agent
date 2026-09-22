// lib/diligence/nebius.js
// Nebius Token Factory adapter for NVIDIA Nemotron. One fixed HTTPS endpoint,
// a server-held key, OpenAI-compatible chat completions with a JSON schema
// response format, a hard deadline with real cancellation, one bounded retry
// on a transient status that honors Retry-After, a streaming size ceiling,
// and a returned-model check. No tool calls, no provider fallback, no
// browser credential, and no log line that carries the packet or the key.
//
// Wire details verified against docs.tokenfactory.nebius.com on 2026-09-19:
// endpoint, bearer auth, response_format json_schema, 429 plus Retry-After.
// Super's regional endpoint and prices were verified in the signed-in
// Token Factory model catalog and organization price table on 2026-09-20.
// Every other model in the table is priced and routed from the public model
// catalog read 2026-09-22. A model whose price is not verified is refused by
// the budget (price_unverified); nothing is priced from memory or a guess.

import { createLogger } from "./host.js";

const log = createLogger("lib/diligence/nebius");

// Token Factory serves each model from one region, and each region has its
// own base URL (the region map in the tokenfactory.nebius.com app config, read
// 2026-09-22). Only these two fixed hosts are ever called.
export const REGION_ENDPOINTS = {
  "us-central1": "https://api.tokenfactory.us-central1.nebius.com/v1/chat/completions",
  "eu-north1": "https://api.tokenfactory.nebius.com/v1/chat/completions",
};
export const NEBIUS_ENDPOINT = REGION_ENDPOINTS["us-central1"];
export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const MODEL_ID_RE = /^nvidia\/[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/;
export const PRICING_AS_OF = "2026-09-19";
export const PRICING_SOURCE = "Third-party catalogs of Nebius Token Factory list prices (mastra.ai, openrouter.ai) read 2026-09-19; not read from a Nebius price page. Verify against the Token Factory console before relying on it.";
const CATALOG_SOURCE = "Nebius Token Factory public model catalog, read 2026-09-22: https://tokenfactory.nebius.com/api/public/models_info (the catalog's authoritative JSON; sha256 d00c0eb7718afc9124118d0afdbe53d153c1f09e9bee39ea679c2823eb6d2b95) and https://tokenfactory.nebius.com/model-catalog.md. List prices per 1M tokens, cheap flavor; cost remains an estimate, not an invoice.";
export const NEMOTRON_MODELS = {
  "nvidia/nemotron-3-super-120b-a12b": { label: "Nemotron 3 Super 120B (A12B)", region: "us-central1", contextTokens: 262144, inputPer1M: 0.3, outputPer1M: 0.9, thinkingToggle: true, pricingVerified: true, pricingAsOf: "2026-09-20", pricingSource: "Nebius Token Factory signed-in model public-endpoint card (Global) and organization Prices table, verified 2026-09-20: https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2Fnemotron-3-super-120b-a12b and https://tokenfactory.nebius.com/organization/prices. Unchanged in the public model catalog read 2026-09-22. List prices exclude applicable taxes; cost remains an estimate, not an invoice." },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { label: "Nemotron 3 Nano 30B (A3B)", region: "eu-north1", contextTokens: 262144, inputPer1M: 0.06, outputPer1M: 0.24, thinkingToggle: true, pricingVerified: true, pricingAsOf: "2026-09-22", pricingSource: CATALOG_SOURCE },
  "nvidia/Nemotron-3_5-Lightning": { label: "Nemotron 3.5 Lightning (30B A3B)", region: "eu-north1", contextTokens: 1048576, inputPer1M: 0.06, outputPer1M: 0.24, thinkingToggle: true, pricingVerified: true, pricingAsOf: "2026-09-22", pricingSource: CATALOG_SOURCE },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { label: "Nemotron 3 Ultra 550B (A55B)", region: "us-central1", contextTokens: 1048576, inputPer1M: 1, outputPer1M: 3, pricingVerified: true, pricingAsOf: "2026-09-22", pricingSource: CATALOG_SOURCE },
};
// Removed from Token Factory; never priced, never called. Source: the Nebius
// August 2026 deprecation notice (VERIFICATION_RECEIPTS.md section 21).
export const REMOVED_MODELS = { "nvidia/Nemotron-3-Nano-Omni": "2026-08-31" };

// The fixed endpoint for a model id: its catalog region, else the Super region.
export function endpointFor(model) {
  const p = Object.prototype.hasOwnProperty.call(NEMOTRON_MODELS, model) ? NEMOTRON_MODELS[model] : null;
  return REGION_ENDPOINTS[(p && p.region) || "us-central1"];
}
export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_RESPONSE_BYTES = 24000 * 4;

export function nebiusStatus(env = process.env) {
  const key = typeof env.NEBIUS_API_KEY === "string" && env.NEBIUS_API_KEY.trim().length > 0;
  const model = typeof env.NEBIUS_MODEL === "string" && env.NEBIUS_MODEL.trim() ? env.NEBIUS_MODEL.trim() : DEFAULT_MODEL;
  const allowed = MODEL_ID_RE.test(model);
  const known = Object.prototype.hasOwnProperty.call(NEMOTRON_MODELS, model);
  const removed = Object.prototype.hasOwnProperty.call(REMOVED_MODELS, model) ? REMOVED_MODELS[model] : null;
  const reasons = [];
  if (!key) reasons.push("NEBIUS_API_KEY is not set");
  if (!allowed) reasons.push("NEBIUS_MODEL must be an NVIDIA model id beginning with nvidia/");
  if (removed) reasons.push("NEBIUS_MODEL " + model + " was removed from Token Factory on " + removed);
  return { provider: "nebius", endpoint: endpointFor(model), configured: key && allowed && !removed, model, modelAllowed: allowed, modelKnown: known, modelRemoved: removed, reasons };
}

// The dated price record for one model id, or null when the id is not in the
// table. Each model is priced on its own; verifying one never verifies another.
export function modelPricing(model) {
  const p = Object.prototype.hasOwnProperty.call(NEMOTRON_MODELS, model) ? NEMOTRON_MODELS[model] : null;
  return p ? { model, inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M, asOf: p.pricingAsOf || PRICING_AS_OF, source: p.pricingSource || PRICING_SOURCE, verified: p.pricingVerified === true } : null;
}

// Estimated cost from dated list prices. An estimate, never a billed amount.
// Null when the model is not in the price table, and null with basis
// price_unverified when its price was never read from a Nebius source: an
// unverified price is not guessed into a spending decision.
export function estimateCost(model, inputTokens, outputTokens) {
  const pricing = modelPricing(model);
  const it = Number.isFinite(inputTokens) ? inputTokens : null, ot = Number.isFinite(outputTokens) ? outputTokens : null;
  if (!pricing) return { usd: null, pricing: null, basis: "unknown_model" };
  if (!pricing.verified) return { usd: null, pricing, basis: "price_unverified" };
  if (it == null || ot == null) return { usd: null, pricing, basis: "usage_missing" };
  const usd = (it * pricing.inputPer1M + ot * pricing.outputPer1M) / 1e6;
  return { usd: Math.round(usd * 1e6) / 1e6, pricing, basis: "list_price_estimate" };
}

// Deliberately over-reserve: one token per UTF-8 byte, plus message framing.
// This is a spend estimate, not a tokenizer or the provider's billing record.
export function estimateTokens(text) {
  return Buffer.byteLength(String(text || ""), "utf8") + 512;
}

// Reserve both possible attempts, including the JSON schema in input pricing.
export function estimateRequestCost(model, request) {
  const cost = estimateCost(model, estimateTokens(JSON.stringify(request)), request.maxTokens);
  return { ...cost, oneAttemptUsd: cost.usd, usd: cost.usd == null ? null : Math.round(cost.usd * 2e6) / 1e6, basis: cost.usd == null ? cost.basis : "two_attempt_reservation" };
}

// A retry may follow a billed response that never reached us. Keep the first
// attempt's allowance instead of refunding it based only on the final usage.
export function estimateCompletionCost(model, result, reservation) {
  const usage = result?.usage;
  const cost = usage && usage.inputTokens >= 0 && usage.outputTokens >= 0 ? estimateCost(model, usage.inputTokens, usage.outputTokens) : null;
  if (!cost || cost.usd == null || !result.ok) return { ...reservation, basis: "reservation_estimate" };
  const prior = result.attempts > 1 ? reservation.oneAttemptUsd : 0;
  return { ...cost, usd: Math.round((cost.usd + prior) * 1e6) / 1e6, basis: prior ? "usage_plus_retry_allowance" : cost.basis };
}

// Provider wording for a spent or expired balance. Deliberately narrow: a rate
// limit or a malformed request must never read as an exhausted credit.
const CREDIT_REFUSAL_RE = /insufficient (?:funds|balance|credits?)|(?:credit|credits|balance) (?:is |are |has |have |has been |have been )?(?:exhausted|expired|depleted|too low)|out of credits?|payment required|top up your (?:balance|account)/i;
export function creditRefusal(text) {
  return CREDIT_REFUSAL_RE.test(String(text || "").slice(0, 8192));
}

function extractJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; } }
  return null;
}

async function readBounded(response, limit) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return text.length > limit ? { tooLarge: true, text: "" } : { tooLarge: false, text };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); return { tooLarge: true, text: "" }; }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return { tooLarge: false, text };
}

// complete({ system, user, schemaName, schema, maxTokens, temperature }, opts)
// Resolves to a normalized result and never throws.
export async function nebiusComplete(request, opts = {}) {
  const env = opts.env || process.env;
  const transport = opts.transport || fetch;
  // The configured reasoner by default; a named job model (the zoning reader,
  // the auditor) when opts.model is given. Same id rules either way.
  const status = nebiusStatus(opts.model ? { ...env, NEBIUS_MODEL: opts.model } : env);
  const base = { ok: false, provider: "nebius", requestedModel: status.model, returnedModel: null, requestId: null, latencyMs: null, attempts: 0, usage: null, finishReason: null, text: null, output: null, error: null, retryable: false, rateLimit: null };
  if (!status.configured) return { ...base, error: status.reasons.some((r) => /NEBIUS_MODEL/.test(r)) ? "model_not_allowed" : "provider_not_configured" };
  if (opts.signal && opts.signal.aborted) return { ...base, error: "cancelled" };
  const deadlineMs = Math.max(1000, Math.min(Number(opts.deadlineMs) || DEFAULT_TIMEOUT_MS, 60000));
  const started = Date.now();
  const deadline = started + deadlineMs;
  const maxTokens = Math.max(64, Math.min(Number(request.maxTokens) || 1400, 4000));
  const body = JSON.stringify({
    model: status.model,
    stream: false,
    temperature: typeof request.temperature === "number" ? request.temperature : 0.1,
    max_tokens: maxTokens,
    // Nemotron 3 Super, Nano 30B and 3.5 Lightning default to a separate
    // thinking phase. These bounded structured tasks need their completion
    // allowance for the final JSON. NVIDIA documents this chat-template control
    // on each model card; models without the flag keep their own defaults.
    ...(NEMOTRON_MODELS[status.model] && NEMOTRON_MODELS[status.model].thinkingToggle ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    messages: [
      { role: "system", content: String(request.system || "") },
      { role: "user", content: String(request.user || "") },
    ],
    response_format: request.schema ? { type: "json_schema", json_schema: { name: request.schemaName || "output", schema: request.schema, strict: true } } : { type: "json_object" },
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.signal) opts.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deadlineMs);
  const cleanup = () => { clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener("abort", abort); };
  let attempts = 0;
  try {
    while (attempts < 2) {
      attempts++;
      const t0 = Date.now();
      let response;
      try {
        response = await transport(status.endpoint, { method: "POST", signal: controller.signal, redirect: "error", headers: { "content-type": "application/json", authorization: "Bearer " + env.NEBIUS_API_KEY.trim() }, body });
      } catch (e) {
        if (opts.signal && opts.signal.aborted) return { ...base, attempts, error: "cancelled" };
        if (controller.signal.aborted) return { ...base, attempts, error: "timeout", latencyMs: Date.now() - started };
        log.warn("DILIGENCE_NEBIUS_ERR", { attempt: attempts, transient: true, err: e });
        if (attempts < 2 && Date.now() + 1000 < deadline) { await new Promise((r) => setTimeout(r, 750)); continue; }
        return { ...base, attempts, error: "provider_unavailable", retryable: true, latencyMs: Date.now() - started };
      }
      const httpStatus = Number(response.status) || 0;
      const rateLimit = { remainingRequests: response.headers && response.headers.get ? response.headers.get("x-ratelimit-remaining-requests") : null, remainingTokens: response.headers && response.headers.get ? response.headers.get("x-ratelimit-remaining-tokens") : null };
      if (response.redirected || (httpStatus >= 300 && httpStatus < 400)) return { ...base, attempts, error: "provider_redirect_denied" };
      if (httpStatus === 429 || httpStatus >= 500) {
        const ra = parseFloat(response.headers && response.headers.get ? response.headers.get("retry-after") : "");
        const wait = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1000;
        log.warn("DILIGENCE_NEBIUS_UPSTREAM", { attempt: attempts, status: httpStatus, transient: true });
        if (attempts < 2 && Date.now() + wait + 500 < deadline) { await new Promise((r) => setTimeout(r, wait)); continue; }
        return { ...base, attempts, error: httpStatus === 429 ? "provider_rate_limited" : "provider_unavailable", retryable: true, rateLimit, latencyMs: Date.now() - started };
      }
      if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) {
        // An exhausted or expired credit is not a bad key. Read a small body
        // to tell them apart; neither the body nor the key is logged.
        const small = await readBounded(response, 8192).catch(() => ({ text: "" }));
        const exhausted = httpStatus === 402 || creditRefusal(small.text);
        return { ...base, attempts, error: exhausted ? "provider_credit_exhausted" : "provider_auth", latencyMs: Date.now() - started };
      }
      if (httpStatus === 404) return { ...base, attempts, error: "model_not_found", latencyMs: Date.now() - started };
      const read = await readBounded(response, MAX_RESPONSE_BYTES);
      const latencyMs = Date.now() - t0;
      if (read.tooLarge) return { ...base, attempts, error: "provider_response_too_large", latencyMs };
      let data = null;
      try { data = JSON.parse(read.text); } catch { data = null; }
      if (httpStatus >= 400) {
        if (creditRefusal(read.text)) return { ...base, attempts, error: "provider_credit_exhausted", latencyMs };
        log.warn("DILIGENCE_NEBIUS_UPSTREAM", { attempt: attempts, status: httpStatus, transient: false, detail: data && data.error ? String(data.error.message || data.error.type || "").slice(0, 120) : null });
        return { ...base, attempts, error: "provider_bad_request", latencyMs, detail: data && data.error ? String(data.error.message || data.error.type || "").slice(0, 200) : null };
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.choices) || !data.choices.length) return { ...base, attempts, error: "invalid_model_output", latencyMs };
      const returnedModel = typeof data.model === "string" ? data.model : null;
      const requestId = typeof data.id === "string" ? data.id.slice(0, 80) : null;
      const usage = data.usage ? { inputTokens: Number.isFinite(data.usage.prompt_tokens) ? data.usage.prompt_tokens : null, outputTokens: Number.isFinite(data.usage.completion_tokens) ? data.usage.completion_tokens : null } : null;
      const choice = data.choices[0] || {};
      const finishReason = choice.finish_reason || null;
      const common = { ...base, attempts, returnedModel, requestId, usage, finishReason, latencyMs, rateLimit };
      if (returnedModel && returnedModel.toLowerCase() !== status.model.toLowerCase()) return { ...common, error: "model_mismatch" };
      if (choice.message && choice.message.refusal) return { ...common, error: "provider_refused" };
      if (choice.message && Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length) return { ...common, error: "invalid_model_output", detail: "tool_calls" };
      const text = choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
      if (finishReason === "length") return { ...common, error: "provider_truncated", text: text.slice(0, 2000) };
      const output = extractJson(text);
      if (!output) return { ...common, error: "invalid_model_output", text: text.slice(0, 2000) };
      return { ...common, ok: true, text, output };
    }
    return { ...base, attempts, error: "provider_unavailable", retryable: true };
  } finally { cleanup(); }
}
