// Shared Redis access for Cividian serverless functions.
// Connects to the store Vercel injected as REDIS_URL (Redis Cloud, TCP) using
// node-redis, with a cached connection reused across warm invocations.
import { createClient } from 'redis';
import { MemoryStore } from './memory-store.js';
import { localMemoryAllowed, StorageUnavailableError } from './storage-policy.js';
import { namespaceRedis } from './redis-namespace.js';

let client = null;
let connecting = null;
// When the last connect attempt failed, no further attempt is made until this
// timestamp. Without it the fail-open this module documents is only true per
// call and false in aggregate: nothing remembered the failure, so every store
// operation in a request paid the full connect timeout again. A page that
// touches the store a handful of times then spends tens of seconds failing,
// which on a 30s function budget is a 504 to the user, from an outage the
// design says should degrade invisibly. Cheap reads still degrade honestly and
// the site stays up; the cost is that recovery is noticed up to COOLDOWN_MS
// late, which is the right trade against turning a cache outage into downtime.
let failedUntil = 0;
const COOLDOWN_MS = 10000;

export async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (client && client.isReady) return namespaceRedis(client, process.env.REDIS_KEY_PREFIX);
  if (Date.now() < failedUntil) return null;
  if (connecting) { try { await connecting; } catch (e) {} return (client && client.isReady) ? namespaceRedis(client, process.env.REDIS_KEY_PREFIX) : null; }
  client = createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 256,
    // 1500ms rather than 5000: this is a cache in front of a request that has a
    // hard 30s ceiling, so a store that has not answered in a second and a half
    // is not worth waiting on. reconnectStrategy returns false outright because
    // the retry ladder ran INSIDE the initial connect, multiplying one outage
    // into four waits before the caller ever saw a null.
    socket: { connectTimeout: 1500, reconnectStrategy: false }
  });
  client.on('error', () => {});
  connecting = client.connect();
  try {
    await connecting;
    failedUntil = 0;
  } catch (e) {
    client = null;
    failedUntil = Date.now() + COOLDOWN_MS;
    // The error handler above is deliberately silent (a reconnect storm would
    // flood the log), but a store that is entirely unreachable is the thing an
    // operator most needs to see, and it was the one failure this file never
    // reported. Once per cool-down window, not once per call.
    console.warn('CIVIDIAN_REDIS_UNAVAILABLE: retry deferred for ' + (COOLDOWN_MS / 1000) + 's');
  }
  connecting = null;
  return (client && client.isReady) ? namespaceRedis(client, process.env.REDIS_KEY_PREFIX) : null;
}

// ops: array of ['RPUSH', key, value], ['LTRIM', key, start, stop],
// or ['EXPIRE', key, seconds] (used to enforce a data-retention window).
export async function multiPush(ops) {
  const c = await getRedis();
  if (!c) return false;
  try {
    const m = c.multi();
    ops.forEach(function (o) {
      if (o[0] === 'RPUSH') m.rPush(o[1], o[2]);
      else if (o[0] === 'LTRIM') m.lTrim(o[1], parseInt(o[2], 10), parseInt(o[3], 10));
      else if (o[0] === 'EXPIRE') m.expire(o[1], parseInt(o[2], 10));
    });
    await m.exec();
    return true;
  } catch (e) { return false; }
}

export async function lrangeAll(key) {
  const c = await getRedis();
  if (!c) return null;
  try { return await c.lRange(key, 0, -1); } catch (e) { return null; }
}

// Optional cache reads/writes. Only unconfigured local development may use
// bounded memory. Private account callers use the Strict variants below.
const memKeys = new MemoryStore();

export async function getKey(key) {
  const c = await getRedis();
  if (!c) { if (!localMemoryAllowed()) return null; const v = memKeys.get(key); return v === undefined ? null : JSON.parse(v); }
  try { const v = await c.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

export async function setKey(key, val) {
  const c = await getRedis();
  if (!c) { if (!localMemoryAllowed()) return false; memKeys.set(key, JSON.stringify(val)); return true; }
  try { await c.set(key, JSON.stringify(val)); return true; } catch (e) { return false; }
}

// Same as setKey but with an expiry (seconds). Used to cache and own external
// API reads (e.g. Census) so a vendor outage or reprice cannot take the data down.
export async function setKeyEx(key, val, seconds) {
  const c = await getRedis();
  if (!c) { if (!localMemoryAllowed()) return false; memKeys.set(key, JSON.stringify(val), { ttlSeconds: seconds }); return true; }
  try { await c.set(key, JSON.stringify(val), { EX: seconds }); return true; } catch (e) { return false; }
}

// Atomic read-and-delete for single-use secrets (magic-link tokens). GETDEL
// guarantees a token can never be redeemed twice, even under a race.
export async function takeKey(key) {
  const c = await getRedis();
  if (!c) {
    if (!localMemoryAllowed()) return null;
    const v = memKeys.get(key);
    memKeys.delete(key);
    return v === undefined ? null : JSON.parse(v);
  }
  try { const v = await c.getDel(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

// Private documents cannot interpret a failed read as an empty account, nor a
// failed write as a saved account. Cache callers retain optional getKey/setKey.
export async function getKeyStrict(key) {
  const c = await getRedis();
  if (!c) {
    if (!localMemoryAllowed()) throw new StorageUnavailableError();
    const value = memKeys.get(key);
    return value === undefined ? null : JSON.parse(value);
  }
  try { const value = await c.get(key); return value === null ? null : JSON.parse(value); }
  catch { throw new StorageUnavailableError(); }
}

export async function setKeyStrict(key, value) {
  if (!await setKey(key, value)) throw new StorageUnavailableError();
  return true;
}

// Internal erasure/restore adapter for the legacy local cache/account map.
export function localLegacySnapshot(){if(!localMemoryAllowed())throw new StorageUnavailableError();memKeys.sweep();return [...memKeys.entries].map(([key,row])=>({key,value:row.value,expiresAt:row.expiresAt}));}
export function applyLocalLegacy(rows){if(!localMemoryAllowed())throw new StorageUnavailableError();for(const row of rows){if(row.value===undefined)memKeys.delete(row.key);else memKeys.set(row.key,row.value,row.expiresAt?{ttlSeconds:Math.max(.001,(row.expiresAt-Date.now())/1000)}:{});}}
