// lib/http.js
// Small shared helpers so every endpoint behaves consistently.

// Hard ceiling on an accumulated body. This runs before auth and before any
// rate limiter on some routes, so an unbounded `data += c` is an unauthenticated
// memory-growth path. Vercel's platform cap bounds it in production; nothing
// bounds it self-hosted or locally. An over-long body resolves to {} rather than
// throwing, which every caller already treats as an empty request and answers
// honestly, so the failure mode is a refusal rather than a crash.
const MAX_BODY_BYTES = 1000000;

// Small authentication forms arrive as parsed objects, strings, or streams.
// Reject duplicate form fields and oversized bodies instead of coercing them.
export async function readFormBody(req, maxBytes = 16384) {
  let raw = req.body;
  try {
    if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) {
      return !Array.isArray(raw) && Buffer.byteLength(JSON.stringify(raw)) <= maxBytes ? raw : {};
    }
    if (raw === undefined || raw === null) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) return {};
        chunks.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(chunks);
    }
    if (!(typeof raw === 'string' || Buffer.isBuffer(raw)) || Buffer.byteLength(raw) > maxBytes) return {};
    const type = String(req.headers?.['content-type'] || '').split(';')[0];
    if (type !== 'application/x-www-form-urlencoded') return {};
    const fields = new URLSearchParams(String(raw)), result = Object.create(null);
    for (const [key, value] of fields) {
      if (Object.hasOwn(result, key)) return {};
      result[key] = value;
    }
    return result;
  } catch { return {}; }
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    let stopped = false;
    req.on("data", (c) => {
      if (stopped) return;
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        stopped = true;
        data = "";
        if (typeof req.destroy === "function") req.destroy();
        resolve({});
      }
    });
    req.on("end", () => {
      if (stopped) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export function methodGuard(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader("Allow", allowed.join(", "));
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return false;
  }
  return true;
}

// Parse query params using the WHATWG URL API.
// Fixes the url.parse() deprecation/security warning across endpoints.
export function query(req) {
  const u = new URL(req.url, "http://localhost");
  return Object.fromEntries(u.searchParams.entries());
}

// Single house fetch-with-timeout. Every external call in the codebase runs
// through an AbortController so a hung vendor can never wedge a serverless
// function up to its 30s maxDuration (a hang there means a 504 to the user and
// a paid function-second bill). Default 8000ms is the house per-call budget;
// aggregations still enforce their own hard overall budget on top. Throws
// AbortError on timeout, which every caller already treats as a vendor failure
// and degrades honestly. Pass a number as the 2nd arg for a bare GET timeout.
export async function fetchWithTimeout(url, optsOrMs, ms) {
  const opts = typeof optsOrMs === "number" ? {} : (optsOrMs || {});
  const timeout = typeof optsOrMs === "number" ? optsOrMs : (ms ?? 8000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new RangeError('invalid_fetch_timeout');
  // The signal remains active while callers consume json/text/stream bytes.
  // Clearing a timer as soon as headers arrive leaves slow bodies unbounded.
  const deadline = AbortSignal.timeout(timeout);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  return await fetch(url, { ...opts, signal });
}
