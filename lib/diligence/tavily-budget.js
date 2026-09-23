// Separate atomic credit meter for every Tavily request. Basic Search costs
// one credit; Extract costs one (basic) or two (advanced) per five pages.
// Charge this conservative allowance before calling; uncertainty is never free.
import { getBudgetRedis } from "./budget-connection.js";
import { storeKind } from "./budget.js";
const memory = new Map();
const PREFIX = "pago:diligence:tavily:v1:";
const METERS = PREFIX + "calls";
// A timed-out reservation stays charged if Redis later completes it. Never retry.
async function bounded(operation, fallback) {
  let timer;
  try { return await Promise.race([operation(), new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), 2000); })]); }
  catch { return fallback; } finally { clearTimeout(timer); }
}
const LUA = `
local total=tonumber(redis.call('GET',KEYS[1]) or '0')
local daily=tonumber(redis.call('GET',KEYS[2]) or '0')
local charge=tonumber(ARGV[3])
if total+charge>tonumber(ARGV[1]) or daily+charge>tonumber(ARGV[2]) then return 0 end
redis.call('INCRBY',KEYS[1],charge)
redis.call('INCRBY',KEYS[2],charge)
redis.call('EXPIRE',KEYS[2],259200)
return 1
`;
export function tavilyPolicy(env = process.env, now = new Date()) {
  const total = Number(env.TAVILY_APPROVED_CREDITS), daily = Number(env.TAVILY_DAILY_CREDITS);
  const expires = Date.parse(env.TAVILY_APPROVAL_EXPIRES_AT || "");
  return { ok: env.DILIGENCE_TAVILY_ENABLED === "1" && !!env.TAVILY_BUDGET_APPROVAL_REFERENCE && Number.isSafeInteger(total) && total >= 1 && Number.isSafeInteger(daily) && daily >= 1 && daily <= total && expires > now.getTime(), total, daily };
}
export async function reserveTavily(deps = {}) {
  const env = deps.env || process.env, now = deps.now || new Date(), p = tavilyPolicy(env, now);
  const credits = deps.credits ?? 2;
  if (!p.ok || !Number.isSafeInteger(credits) || credits < 1 || credits > 20) return false;
  const key = PREFIX + now.toISOString().slice(0,10), totalKey = PREFIX + "total";
  if (storeKind(env) === "memory") {
    const total = memory.get(totalKey) || 0, daily = memory.get(key) || 0;
    if (total + credits > p.total || daily + credits > p.daily) return false;
    memory.set(totalKey,total+credits); memory.set(key,daily+credits); return true;
  }
  if (storeKind(env) !== "redis") return false;
  return bounded(async () => {
    const db = await (deps.connect || getBudgetRedis)();
    if (!db) return false;
    return Number(await db.eval(LUA,{ keys:[totalKey,key], arguments:[String(p.total),String(p.daily),String(credits)] })) === 1;
  }, false);
}

export async function recordTavilyCall(action, deps = {}) {
  if (!["search", "extract"].includes(action)) return false;
  const env = deps.env || process.env;
  if (storeKind(env) === "memory") { memory.set(METERS + action, (memory.get(METERS + action) || 0) + 1); return true; }
  if (storeKind(env) !== "redis") return false;
  return bounded(async () => {
    const db = await (deps.connect || getBudgetRedis)();
    if (!db) return false;
    await db.hIncrBy(METERS, action, 1); return true;
  }, false);
}

export async function tavilySnapshot(deps = {}) {
  const env = deps.env || process.env;
  const dayKey = PREFIX + (deps.now || new Date()).toISOString().slice(0,10);
  const empty = { dailyReservedCredits: null, reservedCredits: null, searchCalls: null, extractCalls: null, unavailable: true };
  if (!env.TAVILY_API_KEY?.trim()) return { ...empty, reason: "no_key" };
  if (storeKind(env) === "memory") return { dailyReservedCredits: memory.get(dayKey) || 0, reservedCredits: memory.get(PREFIX + "total") || 0, searchCalls: memory.get(METERS + "search") || 0, extractCalls: memory.get(METERS + "extract") || 0, unavailable: false };
  if (storeKind(env) !== "redis") return empty;
  let timer;
  try { return await Promise.race([
    (async () => {
      const db = await (deps.connect || getBudgetRedis)(); if (!db) return empty;
      const [credits, daily, calls] = await Promise.all([db.get(PREFIX + "total"), db.get(dayKey), db.hGetAll(METERS)]);
      return { dailyReservedCredits: Number(daily || 0), reservedCredits: Number(credits || 0), searchCalls: Number(calls.search || 0), extractCalls: Number(calls.extract || 0), unavailable: false };
    })(),
    new Promise((resolve) => { timer = setTimeout(() => resolve(empty), 2000); }),
  ]); } catch { return empty; } finally { clearTimeout(timer); }
}
