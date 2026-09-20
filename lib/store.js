// lib/store.js
// ONE canonical data store for the platform, running on the SAME Redis the rest
// of Cividian already uses (node-redis over REDIS_URL via lib/redis.js). The fix-pack
// originally targeted Upstash REST (KV_REST_API_*), which this site does not have
// set, so its persistence would have silently fallen back to ephemeral memory.
// This adapter exposes the small command surface the new endpoints expect
// (get/set/incr/expire/lpush/lrange/sadd/scard/hincrby/hgetall) on top of the
// existing connection, plus JSON helpers. Bounded in-memory storage is available
// only in local development without REDIS_URL, never on deployed instances.

import { getRedis } from "./redis.js";
import { MemoryStore } from "./memory-store.js";
import { requireLocalMemory, StorageUnavailableError } from "./storage-policy.js";

let memoryFallback = null;
function mem() {
  requireLocalMemory();
  if (memoryFallback) return memoryFallback;
  const map = new MemoryStore();
  memoryFallback = {
    snapshot() {map.sweep();return [...map.entries].map(([key,row])=>({key,value:structuredClone(row.value),expiresAt:row.expiresAt}));},
    apply(rows) {for(const row of rows){if(row.value===undefined)map.delete(row.key);else map.set(row.key,row.value,row.expiresAt?{ttlSeconds:Math.max(.001,(row.expiresAt-Date.now())/1000)}:{});}},
    async createIndexed(recordKey, payload, clientKey, indexKey, id, ttl) {
      const existing = map.get(clientKey);
      if (existing != null) return JSON.parse(existing);
      if (map.get(recordKey) != null) throw Object.assign(Error('record_exists'),{code:'record_exists'});
      map.set(recordKey,payload); map.set(clientKey,JSON.stringify(id),{ttlSeconds:ttl});
      map.set(indexKey,[id,...(map.get(indexKey)||[])]);
      return id;
    },
    async compareIndexed(k,before,after,entry) {
      if ((map.get(k) ?? null)!==before) return false;
      map.set(k,after);
      if(!map.get(entry.key)){map.set(entry.key,JSON.stringify(entry.value));map.set(entry.index,[entry.id,...(map.get(entry.index)||[])]);}
      return true;
    },
    async lrem(k,v) {const a=map.get(k)||[];const next=a.filter(x=>x!==v);map.set(k,next,{keepTtl:true});return a.length-next.length;},
    async compareMany(entries, index) {
      if (entries.some(e => (map.get(e.key) ?? null) !== e.before)) return false;
      for (const e of entries) map.set(e.key, e.after);
      if (index) map.set(index.key, [index.id, ...(map.get(index.key) || [])], { keepTtl: true });
      return true;
    },
    async compareSet(k, expected, next, otherKey, otherValue) {
      if ((map.get(k) ?? null) !== expected) return false;
      map.set(k, next);
      if (otherKey) map.set(otherKey, otherValue);
      return true;
    },
    async get(k) { const v = map.get(k); return v === undefined ? null : v; },
    async set(k, v, opts) { map.set(k, v, opts && opts.ex ? { ttlSeconds: opts.ex } : {}); return "OK"; },
    async incr(k) { const n = (Number(map.get(k)) || 0) + 1; map.set(k, n, { keepTtl: true }); return n; },
    async expire(k, s) { return map.expire(k, s); },
    async lpush(k, v) { const a = [v, ...(map.get(k) || [])]; map.set(k, a, { keepTtl: true }); return a.length; },
    async lrange(k, a, b) { const arr = map.get(k) || []; return arr.slice(a, b === -1 ? undefined : b + 1); },
    async sadd(k, v) { const s = new Set(map.get(k) || []); const had = s.has(v); s.add(v); map.set(k, s, { keepTtl: true }); return had ? 0 : 1; },
    async scard(k) { const s = map.get(k); return s ? s.size : 0; },
    async hincrby(k, f, n) { const h = { ...(map.get(k) || {}) }; h[f] = (Number(h[f]) || 0) + n; map.set(k, h, { keepTtl: true }); return h[f]; },
    async hgetall(k) { return map.get(k) || null; },
  };
  return memoryFallback;
}

// Adapter that maps the lowercase command surface onto node-redis v4 (camelCase),
// Memory is available only for unconfigured local development. A configured
// outage or deployed missing store throws; callers may degrade optional reads,
// but account/credential writes must never report a temporary local success.
const adapter = {
  async lrem(k,v) {const c=await getRedis();if(!c)return mem().lrem(k,v);try{return await c.lRem(k,0,v);}catch{throw new StorageUnavailableError();}},
  async get(k) { const c = await getRedis(); if (!c) return mem().get(k); try { return await c.get(k); } catch { return mem().get(k); } },
  async set(k, v, opts) {
    const c = await getRedis(); if (!c) return mem().set(k, v, opts);
    try { return opts && opts.ex ? await c.set(k, v, { EX: opts.ex }) : await c.set(k, v); }
    catch { return mem().set(k, v, opts); }
  },
  async incr(k) { const c = await getRedis(); if (!c) return mem().incr(k); try { return await c.incr(k); } catch { return mem().incr(k); } },
  async expire(k, s) { const c = await getRedis(); if (!c) return mem().expire(k, s); try { return await c.expire(k, s); } catch { return mem().expire(k, s); } },
  async lpush(k, v) { const c = await getRedis(); if (!c) return mem().lpush(k, v); try { return await c.lPush(k, v); } catch { return mem().lpush(k, v); } },
  async lrange(k, a, b) { const c = await getRedis(); if (!c) return mem().lrange(k, a, b); try { return await c.lRange(k, a, b); } catch { return mem().lrange(k, a, b); } },
  async sadd(k, v) { const c = await getRedis(); if (!c) return mem().sadd(k, v); try { return await c.sAdd(k, v); } catch { return mem().sadd(k, v); } },
  async scard(k) { const c = await getRedis(); if (!c) return mem().scard(k); try { return await c.sCard(k); } catch { return mem().scard(k); } },
  async hincrby(k, f, n) { const c = await getRedis(); if (!c) return mem().hincrby(k, f, n); try { return await c.hIncrBy(k, f, n); } catch { return mem().hincrby(k, f, n); } },
  async hgetall(k) { const c = await getRedis(); if (!c) return mem().hgetall(k); try { const h = await c.hGetAll(k); return h && Object.keys(h).length ? h : null; } catch { return mem().hgetall(k); } },
};

export function store() { return adapter; }

export async function createIndexedJSON(recordKey, record, clientKey, indexKey, id, ttlSeconds) {
  const client=await getRedis(),payload=JSON.stringify(record);
  if(!client)return mem().createIndexed(recordKey,payload,clientKey,indexKey,id,ttlSeconds);
  const script=`local existing=redis.call('GET',KEYS[2])
    if existing then return existing end
    if redis.call('EXISTS',KEYS[1]) == 1 then return 'record_exists' end
    redis.call('SET',KEYS[1],ARGV[1])
    redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3])
    redis.call('LPUSH',KEYS[3],ARGV[4])
    return ARGV[2]`;
  let result;try{result=await client.eval(script,{keys:[recordKey,clientKey,indexKey],arguments:[payload,JSON.stringify(id),String(ttlSeconds),id]});}catch{throw new StorageUnavailableError();}
  if(result==='record_exists')throw Object.assign(Error('record_exists'),{code:'record_exists'});
  return JSON.parse(result);
}

// All guards are checked before any write. Identity claims require both the
// username AND the email credential to be free, across processes.
export async function compareManyJSON(entries, index) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 8) throw new Error('invalid_transaction');
  if (index && (!index.key || typeof index.id !== 'string' || entries.some(e => e.key === index.key))) throw new Error('invalid_transaction_index');
  const rows = entries.map(e => ({ key: e.key, before: e.expected == null ? null : JSON.stringify(e.expected), after: JSON.stringify(e.value) }));
  const client = await getRedis();
  if (!client) return mem().compareMany(rows, index);
  const script = `local n=tonumber(ARGV[1]); if #KEYS>n then local t=redis.call('TYPE',KEYS[n+1]).ok; if t~='none' and t~='list' then return redis.error_reply('invalid_transaction_index') end end
  for i=1,n do
    local current = redis.call('GET', KEYS[i])
    local offset = 1+(i-1)*3
    if ARGV[offset+1] == 'missing' then
      if current then return 0 end
    elseif current ~= ARGV[offset+2] then return 0 end
  end
  for i=1,n do redis.call('SET', KEYS[i], ARGV[1+(i-1)*3+3]) end
  if #KEYS>n then redis.call('LPUSH',KEYS[n+1],ARGV[2+n*3]) end
  return 1`;
  try { return await client.eval(script, { keys: [...rows.map(e => e.key), ...(index ? [index.key] : [])], arguments: [String(rows.length), ...rows.flatMap(e => [e.before === null ? 'missing' : 'present', e.before ?? '', e.after]), ...(index ? [index.id] : [])] }) === 1; }
  catch { throw new StorageUnavailableError(); }
}

// JSON helpers used by the cache layer, sessions, and account records.
export async function getJSON(key) {
  const raw = await adapter.get(key);
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setJSON(key, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  if (ttlSeconds) return adapter.set(key, payload, { ex: ttlSeconds });
  return adapter.set(key, payload);
}

// Retained explicit strict-write API. Both it and the general adapter refuse
// ephemeral fallback on deployed/configured outages; callers report a failure.
export async function setJSONStrict(key, value) {
  const c = await getRedis();
  if (!c) {
    // mem() checks the local-only policy before every operation.
    return mem().set(key, JSON.stringify(value));
  }
  try { return await c.set(key, JSON.stringify(value)); } catch { throw new StorageUnavailableError(); }
}

// Compare the index and write its credential in one Redis transaction. This
// prevents concurrent key creation/use/revocation from losing index entries.
// Single logical Redis database, matching the existing REDIS_URL deployment.
export async function compareSetJSON(key, expected, value, additional) {
  const before = expected === null ? null : JSON.stringify(expected);
  const after = JSON.stringify(value);
  const otherKey = additional?.key || '';
  const otherValue = additional ? JSON.stringify(additional.value) : '';
  const c = await getRedis();
  if (!c) return mem().compareSet(key, before, after, otherKey, otherValue);
  const script = `
    local previous = redis.call('GET', KEYS[1])
    if ARGV[1] == 'missing' then
      if previous then return 0 end
    elseif previous ~= ARGV[2] then return 0 end
    redis.call('SET', KEYS[1], ARGV[3])
    if #KEYS == 2 then redis.call('SET', KEYS[2], ARGV[4]) end
    return 1`;
  try { return await c.eval(script, { keys: otherKey ? [key, otherKey] : [key], arguments: [before === null ? 'missing' : 'present', before || '', after, otherValue] }) === 1; }
  catch { throw new StorageUnavailableError(); }
}

// Commit a state transition and its durable outbox entry together.
export async function compareSetIndexedJSON(key,expected,value,entry){
 const client=await getRedis(),before=JSON.stringify(expected),after=JSON.stringify(value);
 if(!client)return mem().compareIndexed(key,before,after,entry);
 const script=`if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
 redis.call('SET',KEYS[1],ARGV[2])
 if redis.call('EXISTS',KEYS[2]) == 0 then redis.call('SET',KEYS[2],ARGV[3]);redis.call('LPUSH',KEYS[3],ARGV[4]) end
 return 1`;
 try{return await client.eval(script,{keys:[key,entry.key,entry.index],arguments:[before,after,JSON.stringify(entry.value),entry.id]})===1;}catch{throw new StorageUnavailableError();}
}

// Internal erasure/restore adapter, available only under the local memory policy.
export function localStoreSnapshot(){return mem().snapshot();}
export function applyLocalStore(rows){return mem().apply(rows);}
