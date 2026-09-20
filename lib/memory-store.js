// @ts-check
// Local development/cache memory only. Deployed account state belongs in Redis.
// Expiry is checked against a clock rather than one timer per write: an older
// timeout must never delete a replacement value, and long TTLs must not overflow.
export class MemoryStore {
  /** @param {{maxEntries?: number, maxBytes?: number, now?: () => number}} [options] */
  constructor({ maxEntries = 4096, maxBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('invalid_memory_limits');
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    /** @type {Map<string, {value: any, expiresAt: number | null, bytes: number}>} */
    this.entries = new Map();
    this.bytes = 0;
  }

  /** @param {string} key */
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    return this.entries.delete(key);
  }

  /** @param {string} key */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) { this.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** @param {string} key @param {any} value @param {{ttlSeconds?: number, keepTtl?: boolean}} [options] */
  set(key, value, { ttlSeconds, keepTtl = false } = {}) {
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) throw new RangeError('invalid_ttl');
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value, (_, v) => v instanceof Set ? [...v] : v) ?? '') + 96;
    if (bytes > this.maxBytes) throw new RangeError('memory_value_too_large');
    const old = this.entries.get(key);
    const expiresAt = ttlSeconds !== undefined ? this.now() + ttlSeconds * 1000 : keepTtl && old ? old.expiresAt : null;
    this.delete(key);
    if (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.sweep();
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.delete(first);
    }
    this.entries.set(key, { value, expiresAt, bytes });
    this.bytes += bytes;
    return this;
  }

  /** @param {string} key @param {number} seconds */
  expire(key, seconds) {
    if (!Number.isFinite(seconds)) throw new RangeError('invalid_ttl');
    if (this.get(key) === undefined) return 0;
    if (seconds <= 0) { this.delete(key); return 1; }
    const entry = this.entries.get(key);
    if (entry) entry.expiresAt = this.now() + seconds * 1000;
    return 1;
  }

  sweep() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt !== null && entry.expiresAt <= now) this.delete(key);
  }

  stats() { this.sweep(); return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes }; }
}
