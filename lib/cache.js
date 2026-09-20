// @ts-check
// Public/derived data only. Private records must use the durable store directly.
import { getJSON, setJSON } from './store.js';

/**
 * Dependencies are injectable for concurrency/failure tests; no provider calls
 * or global mutable test hooks are needed. Sharing is process-local, not a
 * distributed lock. Separate instances may each make one upstream request.
 * @param {{get?: (key: string) => Promise<any>, set?: (key: string, value: any, ttl: number) => Promise<any>, maxInFlight?: number}} [options]
 */
export function createCache({ get = getJSON, set = setJSON, maxInFlight = 128 } = {}) {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new RangeError('invalid_cache_limit');
  /** @type {Map<string, Promise<any>>} */
  const flights = new Map();
  const successful = value => value != null && !(typeof value === 'object' && (value.ok === false || value.found === false || value.error));
  const tag = (value, state) => value && typeof value === 'object' && !Array.isArray(value) ? { ...value, _cache: state } : value;
  /** @param {string} key @param {number} ttlSeconds @param {() => Promise<any>} producer */
  return async function cached(key, ttlSeconds, producer) {
    if (typeof key !== 'string' || !key || key.length > 512) throw new RangeError('invalid_cache_key');
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('invalid_cache_ttl');
    const fullKey = 'cache:' + key;
    const existing = flights.get(fullKey);
    if (existing) return existing;
    if (flights.size >= maxInFlight) throw new Error('cache_capacity_exceeded');
    const flight = (async () => {
      try { const hit = await get(fullKey); if (successful(hit)) return tag(hit, 'hit'); } catch { /* Optional cache. */ }
      const fresh = await producer();
      if (successful(fresh)) { try { await set(fullKey, fresh, ttlSeconds); } catch { /* The sourced result still stands. */ } }
      return tag(fresh, 'miss');
    })();
    flights.set(fullKey, flight);
    try { return await flight; } finally { flights.delete(fullKey); }
  };
}

export const cached = createCache();
export const TTL = {
  CENSUS: 86400,
  GEOCODE: 30 * 86400,
  PARCELS: 6 * 3600,
  SIGNALS: 60,
};
