// Shared security helpers for Cividian serverless functions.
// Centralizes rate limiting, same-origin abuse checks, constant-time secret
// comparison, and client-IP extraction so every endpoint enforces the same
// controls. Sensitive operations fail closed on storage failure. Only explicitly
// marked public probes may continue with a degraded limiter.
import crypto from 'crypto';
import { isIP } from 'node:net';
import { store } from './store.js';
import { siteOrigin } from './deployment.js';

export function clientIp(req) {
  // Forwarding headers on the standalone server are caller-controlled.
  const raw = process.env.VERCEL === '1'
    ? req.headers?.['x-vercel-forwarded-for'] : req.socket?.remoteAddress;
  if (typeof raw !== 'string' || !isIP(raw)) return 'unknown';
  if (isIP(raw) === 4) return raw;
  const canonical = new URL('http://[' + raw + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

// Fixed-window per-IP limiter. Returns { ok, remaining, degraded }.
// The bounded in-memory store is available only for unconfigured local work.
export async function rateLimit(req, bucket, max, windowSec, { failOpen = false } = {}) {
  try {
    const c = store();
    const ip = clientIp(req);
    // The current window is part of the key, so a new window always uses a
    // fresh counter even if the EXPIRE below is dropped. Without this, a
    // swallowed EXPIRE failure would leave the counter growing forever and
    // permanently lock a legitimate IP out of the endpoint.
    const win = Math.floor(Date.now() / (windowSec * 1000));
    const key = 'pago:rl:' + bucket + ':' + ip + ':' + win;
    const n = await c.incr(key);
    // TTL is a cleanup optimization (reclaim old window keys), not the reset
    // mechanism; 2x the window covers clock skew before the key expires.
    if (n === 1) await c.expire(key, windowSec * 2);
    return { ok: n <= max, remaining: Math.max(0, max - n), degraded: !process.env.REDIS_URL, unavailable: false };
  } catch (e) {
    return { ok: failOpen, remaining: 0, degraded: true, unavailable: true };
  }
}

// True when the request looks same-origin. Browsers send Origin on same-origin
// POST and Referer on same-origin GET. Compare complete origins to deployment
// configuration. Host and forwarded-host never establish a trusted origin.
export function validRequestHost(req) {
  if (req.httpVersion === '1.0') return false;
  const host = req.headers?.host;
  if (typeof host !== 'string' || !host || /[\s\\/@?#]/.test(host)) return false;
  try { const url = new URL('https://' + host); return !!url.hostname && url.pathname === '/' && !url.username && !url.password; } catch { return false; }
}

export function sameOrigin(req) {
  if (!validRequestHost(req)) return false;
  try {
    const trusted = [siteOrigin()];
    // Vercel injects these deployment identifiers; request headers cannot add
    // an alias. Email and OAuth callbacks still use SITE_URL exclusively.
    if (process.env.VERCEL === '1') for (const name of ['VERCEL_URL', 'VERCEL_BRANCH_URL']) {
      const host = process.env[name];
      if (typeof host === 'string' && /^[a-z0-9-]+\.vercel\.app$/.test(host)) trusted.push('https://' + host);
    }
    const originHeader = req.headers.origin;
    const raw = originHeader !== undefined ? originHeader : req.headers.referer;
    if (typeof raw !== 'string' || /[\s\\]/.test(raw)) return false;
    const url = new URL(raw);
    if (url.username || url.password || !/^https?:$/.test(url.protocol)) return false;
    if (originHeader !== undefined && (url.pathname !== '/' || url.search || url.hash)) return false;
    return trusted.includes(url.origin) && url.host === new URL(url.protocol + '//' + req.headers.host).host;
  } catch { return false; }
}

// Constant-time comparison for secrets (admin password, tokens). Avoids the
// timing side-channel of `a === b`. Length mismatch returns false.
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

export function tooMany(res, limit) {
  if (limit?.unavailable) return res.status(503).json({ ok: false, error: 'storage_unavailable', message: 'Please try again shortly.' });
  return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down and try again shortly.' });
}

export function forbidden(res) {
  return res.status(403).json({ ok: false, error: 'Forbidden.' });
}
