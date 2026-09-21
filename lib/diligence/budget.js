// lib/diligence/budget.js
// A priced, atomic dollar reservation for live inference. This is the control
// lib/ai-authorization.js says every paid path must have before it may run:
// an explicit approval reference, a cumulative approved ceiling, an optional
// approval expiry, a daily cap at or below it, a per-run cap, a concurrency
// cap, and a store that reserves the
// estimated cost before the request and settles the estimate from reported
// usage afterwards. Failed calls are not refunded, because the provider may
// have billed them.
//
// Redis (Lua, one round trip) on any production-like host; the local
// in-process store only where lib/storage-policy.js already permits memory.
// A production-like host without Redis fails closed.

import { randomUUID } from "node:crypto";
import { getBudgetRedis } from "./budget-connection.js";
import { localMemoryAllowed } from "../storage-policy.js";
import { productionLike } from "../deployment.js";

const MICRO = 1e6;
const DAY_TTL = 3 * 86400;
const INFLIGHT_TTL = 120;
const KEY_DAY = (day) => "pago:diligence:budget:" + day;
const KEY_INFLIGHT = "pago:diligence:inflight";
// Keep this ledger across UTC days, deployments, and approval-note edits.
// It has no TTL. Clearing it would reset the authorized spending ceiling.
const KEY_TOTAL = "pago:diligence:budget:total";
const KEY_RESERVATION = (id) => "pago:diligence:reservation:" + id;

const RESERVE_LUA = `
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
local inflight = tonumber(redis.call('GET', KEYS[2]) or '0')
local total = tonumber(redis.call('HGET', KEYS[3], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[3], 'spent') or '0')
if inflight >= tonumber(ARGV[3]) then return {0, 'concurrency', reserved + spent} end
if reserved + spent + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return {0, 'budget', reserved + spent} end
if total + tonumber(ARGV[1]) > tonumber(ARGV[6]) then return {0, 'total', total} end
redis.call('HINCRBY', KEYS[1], 'reserved', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('HINCRBY', KEYS[3], 'reserved', ARGV[1])
redis.call('SET', KEYS[4], ARGV[1], 'EX', ARGV[4])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return {1, 'ok', reserved + spent + tonumber(ARGV[1]), total + tonumber(ARGV[1])}
`;
const SETTLE_LUA = `
if redis.call('GET', KEYS[4]) ~= ARGV[1] then return 0 end
redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'spent', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'runs', 1)
local r = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
if r < 0 then redis.call('HSET', KEYS[1], 'reserved', 0) end
redis.call('HINCRBY', KEYS[3], 'reserved', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[3], 'spent', ARGV[2])
redis.call('HINCRBY', KEYS[3], 'runs', 1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
local i = redis.call('DECR', KEYS[2])
if i < 0 then redis.call('SET', KEYS[2], 0) end
redis.call('DEL', KEYS[4])
return 1
`;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

export function budgetPolicy(env = process.env, now = new Date()) {
  const reference = String(env.AI_BUDGET_APPROVAL_REFERENCE || "").trim();
  const approved = num(env.AI_APPROVED_BUDGET_USD);
  const dailyRaw = env.DILIGENCE_DAILY_BUDGET_USD === undefined ? approved : num(env.DILIGENCE_DAILY_BUDGET_USD);
  const perRun = env.DILIGENCE_PER_RUN_BUDGET_USD === undefined ? 0.25 : num(env.DILIGENCE_PER_RUN_BUDGET_USD);
  const concurrent = env.DILIGENCE_MAX_CONCURRENT === undefined ? 3 : num(env.DILIGENCE_MAX_CONCURRENT);
  const expiresAt = String(env.AI_BUDGET_APPROVAL_EXPIRES_AT || "").trim() || null;
  const reasons = [];
  if (expiresAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)))) reasons.push("AI_BUDGET_APPROVAL_EXPIRES_AT must be an ISO timestamp with timezone");
  else if (expiresAt && Date.parse(expiresAt) <= now.getTime()) reasons.push("budget approval has expired");
  if (!reference) reasons.push("AI_BUDGET_APPROVAL_REFERENCE is not set");
  if (!(approved > 0)) reasons.push("AI_APPROVED_BUDGET_USD must be a positive number");
  if (!(dailyRaw > 0) || dailyRaw > approved) reasons.push("DILIGENCE_DAILY_BUDGET_USD must be positive and at or below AI_APPROVED_BUDGET_USD");
  if (!(perRun > 0) || perRun > dailyRaw) reasons.push("DILIGENCE_PER_RUN_BUDGET_USD must be positive and at or below the daily cap");
  if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 20) reasons.push("DILIGENCE_MAX_CONCURRENT must be an integer from 1 to 20");
  return { ok: reasons.length === 0, reasons, reference: reference || null, expiresAt, approvedUsd: approved > 0 ? approved : null, dailyUsd: dailyRaw > 0 ? dailyRaw : null, perRunUsd: perRun > 0 ? perRun : null, maxConcurrent: Number.isInteger(concurrent) ? concurrent : null };
}

// Which store backs reservations on this host. Never memory on a deployment.
export function storeKind(env = process.env) {
  if (env.DILIGENCE_BUDGET_REDIS_URL || env.REDIS_URL) return "redis";
  if (env === process.env ? localMemoryAllowed() : !productionLike(env)) return "memory";
  return "none";
}

// The whole live-inference gate as data: every condition, and every reason it
// is not met. The client shows the reasons; nothing here is a secret.
export function liveInferenceStatus(env = process.env, providerStatus) {
  const policy = budgetPolicy(env);
  const store = storeKind(env);
  const reasons = [];
  if (!providerStatus || !providerStatus.configured) reasons.push(...((providerStatus && providerStatus.reasons) || ["provider not configured"]));
  if (env.DILIGENCE_LIVE_INFERENCE !== "1") reasons.push("DILIGENCE_LIVE_INFERENCE is not 1");
  reasons.push(...policy.reasons);
  if (store === "none") reasons.push("no budget store: REDIS_URL is required on a deployed host");
  const live = reasons.length === 0;
  const fixture = !live && env.DILIGENCE_FIXTURE_MODE === "1" && !productionLike(env);
  const fixtureRefused = env.DILIGENCE_FIXTURE_MODE === "1" && productionLike(env);
  return { live, mode: live ? "live" : fixture ? "fixture" : "unavailable", reasons, fixtureRefused, guestAllowed: env.DILIGENCE_GUEST_INFERENCE === "1", policy: { reference: policy.reference, expiresAt: policy.expiresAt, approvedUsd: policy.approvedUsd, dailyUsd: policy.dailyUsd, perRunUsd: policy.perRunUsd, maxConcurrent: policy.maxConcurrent }, store };
}

// In-process store, local only.
const memory = { days: new Map(), reservations: new Set(), inflight: 0, total: { reserved: 0, spent: 0, runs: 0 } };
function memDay(day) { if (!memory.days.has(day)) memory.days.set(day, { reserved: 0, spent: 0, runs: 0 }); return memory.days.get(day); }
export const __test = { reset() { memory.days.clear(); memory.reservations.clear(); memory.inflight = 0; memory.total = { reserved: 0, spent: 0, runs: 0 }; }, memory };

function day(now) { return (now || new Date()).toISOString().slice(0, 10); }

export async function reserveRun({ estimateUsd, env = process.env, now, connect = getBudgetRedis }) {
  const policy = budgetPolicy(env, now);
  if (!policy.ok) return { ok: false, error: "budget_policy_invalid", reasons: policy.reasons };
  const est = Math.max(1, Math.ceil(Number(estimateUsd) * MICRO));
  if (!Number.isSafeInteger(est) || !(Number(estimateUsd) > 0) || Number(estimateUsd) > policy.perRunUsd) return { ok: false, error: "per_run_cap_exceeded", perRunUsd: policy.perRunUsd, estimateUsd };
  const cap = Math.floor(policy.dailyUsd * MICRO);
  const totalCap = Math.floor(policy.approvedUsd * MICRO);
  const d = day(now);
  const kind = storeKind(env);
  const reservationId = (kind === "memory" ? "mem" : "redis") + ":" + d + ":" + est + ":" + randomUUID();
  if (kind === "memory") {
    const rec = memDay(d);
    if (memory.inflight >= policy.maxConcurrent) return { ok: false, error: "concurrency_limit", inflight: memory.inflight };
    if (rec.reserved + rec.spent + est > cap) return { ok: false, error: "daily_budget_exhausted", remainingUsd: Math.max(0, (cap - rec.reserved - rec.spent) / MICRO) };
    if (memory.total.reserved + memory.total.spent + est > totalCap) return { ok: false, error: "approved_budget_exhausted", remainingUsd: Math.max(0, (totalCap - memory.total.reserved - memory.total.spent) / MICRO) };
    rec.reserved += est; memory.inflight++;
    memory.total.reserved += est; memory.reservations.add(reservationId);
    return { ok: true, reservationId, store: "memory", estimateUsd, remainingUsd: Math.min(cap - rec.reserved - rec.spent, totalCap - memory.total.reserved - memory.total.spent) / MICRO };
  }
  if (kind !== "redis") return { ok: false, error: "budget_store_unavailable" };
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const db = await connect();
        if (!db) return { ok: false, error: "budget_store_unavailable" };
        const r = await db.eval(RESERVE_LUA, { keys: [KEY_DAY(d), KEY_INFLIGHT, KEY_TOTAL, KEY_RESERVATION(reservationId)], arguments: [String(est), String(cap), String(policy.maxConcurrent), String(DAY_TTL), String(INFLIGHT_TTL), String(totalCap)] });
        if (!Array.isArray(r) || Number(r[0]) !== 1) {
          const why = Array.isArray(r) ? String(r[1]) : "unknown";
          return why === "concurrency" ? { ok: false, error: "concurrency_limit" } : { ok: false, error: why === "total" ? "approved_budget_exhausted" : "daily_budget_exhausted", remainingUsd: Array.isArray(r) ? Math.max(0, ((why === "total" ? totalCap : cap) - Number(r[2])) / MICRO) : null };
        }
        return { ok: true, reservationId, store: "redis", estimateUsd, remainingUsd: Math.min(cap - Number(r[2]), totalCap - Number(r[3])) / MICRO };
      })(),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: "budget_store_unavailable" }), 2500); }),
    ]);
  } catch { return { ok: false, error: "budget_store_unavailable" }; }
  finally { clearTimeout(timer); }
}

// Replace the reservation with the actual estimate from reported usage. A
// failed call settles at its reservation so the attempt still counts.
export async function settleRun(reservationId, actualUsd, { env = process.env, connect = getBudgetRedis } = {}) {
  if (typeof reservationId !== "string" || !/^(mem|redis):\d{4}-\d{2}-\d{2}:\d+:[a-f0-9-]{36}$/.test(reservationId)) return false;
  const [kind, d, estRaw] = reservationId.split(":");
  const est = Number(estRaw) || 0;
  const actual = Math.max(0, Math.ceil((actualUsd != null && Number.isFinite(Number(actualUsd)) && Number(actualUsd) >= 0 ? Number(actualUsd) : est / MICRO) * MICRO));
  if (kind === "mem") {
    if (!memory.reservations.delete(reservationId)) return false;
    const rec = memDay(d);
    rec.reserved = Math.max(0, rec.reserved - est); rec.spent += actual; rec.runs++; memory.inflight = Math.max(0, memory.inflight - 1);
    memory.total.reserved -= est; memory.total.spent += actual; memory.total.runs++;
    return true;
  }
  try {
    const db = await connect();
    if (!db) return false;
    return Number(await db.eval(SETTLE_LUA, { keys: [KEY_DAY(d), KEY_INFLIGHT, KEY_TOTAL, KEY_RESERVATION(reservationId)], arguments: [String(est), String(actual), String(DAY_TTL)] })) === 1;
  } catch { return false; }
}

export async function budgetSnapshot({ env = process.env, now, connect = getBudgetRedis } = {}) {
  const policy = budgetPolicy(env);
  const d = day(now);
  const kind = storeKind(env);
  const cap = policy.dailyUsd != null ? policy.dailyUsd : null;
  function totalSnapshot(rec) {
    const reserved = rec ? Number(rec.reserved || 0) / MICRO : null;
    const spent = rec ? Number(rec.spent || 0) / MICRO : null;
    return { approvedUsd: policy.approvedUsd, expiresAt: policy.expiresAt, totalReservedUsd: reserved, totalSpentUsd: spent, totalRemainingUsd: rec && policy.approvedUsd != null ? Math.max(0, Math.floor(policy.approvedUsd * MICRO) - Number(rec.reserved || 0) - Number(rec.spent || 0)) / MICRO : null };
  }
  if (kind === "memory") {
    const rec = memDay(d);
    const used = (rec.reserved + rec.spent) / MICRO;
    return { store: "memory", day: d, dailyUsd: cap, reservedUsd: rec.reserved / MICRO, spentUsd: rec.spent / MICRO, runs: rec.runs, inflight: memory.inflight, remainingUsd: cap == null ? null : Math.max(0, cap - used), ...totalSnapshot(memory.total) };
  }
  if (kind !== "redis") return { store: "none", day: d, dailyUsd: cap, reservedUsd: null, spentUsd: null, runs: null, inflight: null, remainingUsd: null, ...totalSnapshot(null) };
  try {
    const db = await connect();
    if (!db) return { store: "redis", day: d, dailyUsd: cap, reservedUsd: null, spentUsd: null, runs: null, inflight: null, remainingUsd: null, unavailable: true, ...totalSnapshot(null) };
    const h = (await db.hGetAll(KEY_DAY(d))) || {};
    const inflight = Number(await db.get(KEY_INFLIGHT)) || 0;
    const reserved = Number(h.reserved || 0) / MICRO, spent = Number(h.spent || 0) / MICRO;
    const total = (await db.hGetAll(KEY_TOTAL)) || {};
    return { store: "redis", day: d, dailyUsd: cap, reservedUsd: reserved, spentUsd: spent, runs: Number(h.runs || 0), inflight, remainingUsd: cap == null ? null : Math.max(0, cap - reserved - spent), ...totalSnapshot(total) };
  } catch { return { store: "redis", day: d, dailyUsd: cap, reservedUsd: null, spentUsd: null, runs: null, inflight: null, remainingUsd: null, unavailable: true, ...totalSnapshot(null) }; }
}
