// lib/diligence/credit.js
// Live-AI credit and ledger status for the judging period. One answer shared
// by the diligence status action, /api/ai-status and the reason stage: is a
// Nebius key present (never its value), what the shared ledger has spent and
// has left, when the approval and the credit expire, and whether live calls
// are paused. When they are, the deterministic brief keeps shipping.
//
// The credit balance itself is not readable through the inference API. An
// exhausted or expired credit is learned from a provider refusal, recorded on
// the ledger, and pauses live calls for CREDIT_PAUSE_MS before one is tried
// again. An operator who knows the credit's expiry may set
// NEBIUS_CREDIT_EXPIRES_AT (ISO timestamp with timezone); it is optional.

import { nebiusStatus, estimateRequestCost, modelPricing } from "./nebius.js";
import { liveInferenceStatus, budgetSnapshot } from "./budget.js";
import { REASONING_SCHEMA } from "./schema.js";
import { tavilyStatus } from "./tavily.js";

export const CREDIT_PAUSE_MS = 6 * 3600 * 1000;
export const REASON_MAX_OUTPUT_TOKENS = 3000;
export const PAUSED_BANNER = "Live AI paused: evidence, scenarios, and the investigation plan still work.";
const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function creditExpiry(env = process.env) {
  const raw = String(env.NEBIUS_CREDIT_EXPIRES_AT || "").trim();
  return raw && ISO_TZ.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : null;
}

// The smallest reservation any reason run can make: the schema alone as input
// and the full completion allowance, both attempts. Below this, no run fits.
export function minRunUsd(model, maxOutputTokens = REASON_MAX_OUTPUT_TOKENS) {
  return estimateRequestCost(model, { system: "", user: "", schemaName: "diligence_reasoning_v1", schema: REASONING_SCHEMA, maxTokens: maxOutputTokens }).usd;
}

function nextUtcMidnight(now) {
  const d = new Date(now.getTime());
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// Why live calls are paused right now, or null. Only meaningful when the
// configuration gate already allows live inference.
export function livePause({ env = process.env, now = new Date(), budget, model, maxOutputTokens }) {
  const t = now.getTime();
  const expires = creditExpiry(env);
  if (expires && Date.parse(expires) <= t) return { reason: "credit_expired", since: expires, retryAfter: null };
  const ex = budget && budget.creditExhaustedAt, ok = budget && budget.lastLiveOkAt;
  if (ex && (!ok || Date.parse(ex) > Date.parse(ok)) && t - Date.parse(ex) < CREDIT_PAUSE_MS) {
    return { reason: "credit_exhausted", since: ex, retryAfter: new Date(Date.parse(ex) + CREDIT_PAUSE_MS).toISOString() };
  }
  if (budget && budget.unavailable) return { reason: "budget_store_unavailable", since: null, retryAfter: null };
  const min = minRunUsd(model, maxOutputTokens);
  if (min == null) return { reason: "price_unverified", since: null, retryAfter: null };
  if (budget && budget.totalRemainingUsd != null && budget.totalRemainingUsd < min) return { reason: "approved_budget_exhausted", since: null, retryAfter: null };
  if (budget && budget.remainingUsd != null && budget.remainingUsd < min) return { reason: "daily_budget_exhausted", since: null, retryAfter: nextUtcMidnight(now) };
  return null;
}

// The status block. Booleans, dollars, dates and reasons; no key material.
export async function creditStatus(env = process.env, deps = {}) {
  const now = deps.now || new Date();
  const provider = nebiusStatus(env);
  const gate = liveInferenceStatus(env, provider);
  const budget = deps.budget || await budgetSnapshot({ env, now, connect: deps.connect });
  const pricing = modelPricing(provider.model);
  const pause = gate.live ? livePause({ env, now, budget, model: provider.model, maxOutputTokens: deps.maxOutputTokens }) : null;
  const expires = creditExpiry(env);
  const approvalExpired = !!(budget.expiresAt && Date.parse(budget.expiresAt) <= now.getTime());
  const exhaustedAt = budget.creditExhaustedAt || null, lastOkAt = budget.lastLiveOkAt || null;
  return {
    provider: "nebius",
    keyPresent: typeof env.NEBIUS_API_KEY === "string" && env.NEBIUS_API_KEY.trim().length > 0,
    model: provider.model,
    pricingVerified: !!(pricing && pricing.verified),
    mode: gate.mode,
    live: gate.live && !pause,
    paused: pause,
    banner: gate.mode === "fixture" || (gate.live && !pause) ? null : PAUSED_BANNER,
    ledger: {
      store: budget.store,
      unavailable: !!budget.unavailable,
      approvedUsd: budget.approvedUsd,
      spentUsd: budget.totalSpentUsd,
      reservedUsd: budget.totalReservedUsd,
      remainingUsd: budget.totalRemainingUsd,
      approvalExpiresAt: budget.expiresAt,
      approvalExpired,
      day: budget.day,
      dailyUsd: budget.dailyUsd,
      dailySpentUsd: budget.spentUsd,
      dailyReservedUsd: budget.reservedUsd,
      dailyRemainingUsd: budget.remainingUsd,
      perRunUsd: gate.policy.perRunUsd,
      maxConcurrent: gate.policy.maxConcurrent,
      inflight: budget.inflight,
      approvalReference: gate.policy.reference,
    },
    tavily: { keyPresent: tavilyStatus(env).keyPresent, calls: budget.tavilyCalls ?? null, credits: budget.tavilyCredits ?? null, note: "Tavily is metered in its own credits and never draws on the Nebius ledger." },
    credit: {
      balanceReadable: false,
      expiresAt: expires,
      expired: !!(expires && Date.parse(expires) <= now.getTime()),
      exhaustedAt,
      lastLiveOkAt: lastOkAt,
      status: pause && (pause.reason === "credit_exhausted" || pause.reason === "credit_expired") ? pause.reason : exhaustedAt && (!lastOkAt || Date.parse(exhaustedAt) > Date.parse(lastOkAt)) ? "last_call_refused" : lastOkAt ? "last_call_ok" : "unknown",
      note: "Nebius does not report the credit balance through the inference API. Exhaustion is learned from a provider refusal; live calls then pause for six hours before one is tried again.",
    },
  };
}
