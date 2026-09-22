// lib/diligence/tavily.js
// Tavily Search and Extract for zoning discovery. Two fixed HTTPS endpoints,
// a server-held key (TAVILY_API_KEY, never logged or returned), a hard
// deadline with real cancellation, no redirects, and a bounded response body.
// Everything Tavily returns is untrusted data: callers filter URLs against an
// allowlist and treat page text as content, never as instructions.
//
// Wire details from docs.tavily.com, read 2026-09-22: POST /search and
// POST /extract, Bearer auth, include_domains, max_results (0 to 20),
// extract of up to 20 URLs per call, results[].raw_content, failed_results[],
// usage.credits when include_usage is true.

import { createLogger } from "./host.js";

const log = createLogger("lib/diligence/tavily");

export const TAVILY_SEARCH = "https://api.tavily.com/search";
export const TAVILY_EXTRACT = "https://api.tavily.com/extract";
export const SEARCH_MAX_BYTES = 512 * 1024;
export const EXTRACT_MAX_BYTES = 6 * 1024 * 1024;

export function tavilyStatus(env = process.env) {
  const keyPresent = typeof env.TAVILY_API_KEY === "string" && env.TAVILY_API_KEY.trim().length > 0;
  return { provider: "tavily", keyPresent, reasons: keyPresent ? [] : ["TAVILY_API_KEY is not set"] };
}

async function readBounded(response, limit) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return Buffer.byteLength(text) > limit ? { tooLarge: true, text: "" } : { tooLarge: false, text };
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

async function post(url, body, limit, opts) {
  const env = opts.env || process.env;
  const status = tavilyStatus(env);
  if (!status.keyPresent) return { ok: false, error: "no_key" };
  const transport = opts.transport || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(Number(opts.deadlineMs) || 10000, 30000)));
  const t0 = Date.now();
  try {
    let response;
    try {
      response = await transport(url, { method: "POST", signal: controller.signal, redirect: "error", headers: { "content-type": "application/json", authorization: "Bearer " + env.TAVILY_API_KEY.trim() }, body: JSON.stringify(body) });
    } catch {
      return { ok: false, error: controller.signal.aborted ? "timeout" : "provider_unavailable", latencyMs: Date.now() - t0 };
    }
    const code = Number(response.status) || 0;
    if (code === 401 || code === 403) return { ok: false, error: "provider_auth", status: code, latencyMs: Date.now() - t0 };
    if (code === 429) return { ok: false, error: "provider_rate_limited", status: code, latencyMs: Date.now() - t0 };
    if (code === 432 || code === 433) return { ok: false, error: "credit_exhausted", status: code, latencyMs: Date.now() - t0 };
    if (code >= 300 && code < 400) return { ok: false, error: "provider_redirect_denied", status: code };
    const read = await readBounded(response, limit);
    const latencyMs = Date.now() - t0;
    if (read.tooLarge) return { ok: false, error: "response_too_large", latencyMs };
    let data = null;
    try { data = JSON.parse(read.text); } catch { data = null; }
    if (code >= 400 || !data || typeof data !== "object") {
      log.warn("DILIGENCE_TAVILY_UPSTREAM", { status: code, endpoint: url === TAVILY_SEARCH ? "search" : "extract" });
      return { ok: false, error: code >= 500 ? "provider_unavailable" : "provider_bad_request", status: code, latencyMs };
    }
    const credits = data.usage && Number.isFinite(Number(data.usage.credits)) ? Number(data.usage.credits) : null;
    return { ok: true, data, latencyMs, credits, requestId: typeof data.request_id === "string" ? data.request_id.slice(0, 80) : null };
  } finally { clearTimeout(timer); }
}

// search({ query, includeDomains, maxResults }) -> { ok, results: [{ url, title, content, score }] }
export async function tavilySearch({ query, includeDomains = [], maxResults = 5, depth = "basic" }, opts = {}) {
  const body = { query: String(query || "").slice(0, 400), search_depth: depth, max_results: Math.max(1, Math.min(Number(maxResults) || 5, 10)), include_answer: false, include_raw_content: false, include_images: false, include_usage: true };
  if (includeDomains.length) body.include_domains = includeDomains.slice(0, 50);
  const r = await post(TAVILY_SEARCH, body, SEARCH_MAX_BYTES, opts);
  if (!r.ok) return r;
  const results = Array.isArray(r.data.results) ? r.data.results : [];
  return {
    ok: true,
    requestId: r.requestId, credits: r.credits, latencyMs: r.latencyMs,
    results: results.slice(0, 10).filter((x) => x && typeof x.url === "string").map((x) => ({
      url: x.url.slice(0, 2048),
      title: typeof x.title === "string" ? x.title.slice(0, 300) : "",
      content: typeof x.content === "string" ? x.content.slice(0, 2000) : "",
      score: Number.isFinite(Number(x.score)) ? Number(x.score) : null,
    })),
  };
}

// extract({ urls }) -> { ok, results: [{ url, rawContent }], failed: [{ url, error }] }
export async function tavilyExtract({ urls = [], depth = "advanced" }, opts = {}) {
  const list = urls.slice(0, 20).map((u) => String(u).slice(0, 2048));
  if (!list.length) return { ok: true, results: [], failed: [], credits: 0, requestId: null, latencyMs: 0 };
  const r = await post(TAVILY_EXTRACT, { urls: list, extract_depth: depth, format: "text", include_images: false, include_usage: true }, EXTRACT_MAX_BYTES, opts);
  if (!r.ok) return r;
  const results = Array.isArray(r.data.results) ? r.data.results : [];
  const failed = Array.isArray(r.data.failed_results) ? r.data.failed_results : [];
  return {
    ok: true,
    requestId: r.requestId, credits: r.credits, latencyMs: r.latencyMs,
    results: results.filter((x) => x && typeof x.url === "string" && typeof x.raw_content === "string").map((x) => ({ url: x.url.slice(0, 2048), rawContent: x.raw_content })),
    failed: failed.filter((x) => x && typeof x.url === "string").map((x) => ({ url: x.url.slice(0, 2048), error: typeof x.error === "string" ? x.error.slice(0, 200) : "failed" })),
  };
}
