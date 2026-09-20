// lib/log.js
// One structured line per event, for every serverless function in this repo.
//
// WHY THIS EXISTS. Every diagnostic in this codebase is a string assembled by
// concatenation and handed to console.log. That is fine to read and impossible
// to query. Asking "how often did the v1 dispatcher fail last week, and on
// which capability" means a regular expression over raw log text, which is
// correct right up until an upstream error message contains a newline or a
// space. Then one event becomes two lines, the count is wrong, and it is wrong
// in the quiet direction where nobody notices. A single JSON object per line
// is queryable in a Vercel log drain, in Datadog, or with jq, and it stays
// correct when the message inside it is hostile.
//
// WHAT THIS DELIBERATELY DOES NOT CHANGE, AND WHY THAT MATTERS. The lines this
// replaces begin with a fixed token: PAGO_V1_ERR, PAGO_AI_ERR,
// PAGO_AI_UPSTREAM_ERR. Anything watching this deployment today is matching on
// that token. So the token survives verbatim as the "evt" field and therefore
// appears verbatim in the emitted line, which means an existing grep for
// PAGO_V1_ERR keeps matching after this change. Renaming those tokens is a
// separate decision from changing their shape. Doing both in one commit would
// silently blind whatever alerting exists, and the failure mode of blinded
// alerting is that it looks exactly like everything being fine.
//
// EVERY LEVEL WRITES TO STDOUT, ON PURPOSE. The conventional choice is stderr
// for errors, and this module does not make it. On Vercel, stream selection is
// what classifies a line's severity in the dashboard and in any drain filter
// downstream, so moving these calls to console.error would reclassify every
// existing PAGO_V1_ERR line. That is an observability change wearing the
// costume of a formatting change. Severity lives in the "level" field, where it
// can be queried; moving streams is a deliberate follow-up, not a side effect.
//
// THIS MODULE MUST NEVER THROW. Every call site it serves is inside a catch
// block. A logger that throws while reporting a handled failure converts a
// degraded-but-honest response into a 500, which is strictly worse than losing
// the line. So every public function is wrapped, serialization is depth and
// length bounded rather than trusting the input, and the worst case here is
// silence.
//
// NO SECRETS, EVER. Field names are matched against a denylist and values are
// scanned for the credential prefixes this platform issues and consumes. This
// is defence in depth and not a permission slip: the rule is still that a
// caller does not hand a credential to a logger. The redaction exists because
// "err" fields carry vendor error strings nobody on this side composed, and a
// vendor that echoes a bearer token back inside a 401 message is a real thing
// that happens.

const LEVELS = { error: 10, warn: 20, info: 30, debug: 40 };

// Read per call rather than at import. A serverless function is imported once
// and invoked many times, so a cached threshold would pin the level to whatever
// the environment looked like at cold start, and tests could not vary it.
function threshold() {
  const raw = String(process.env.LOG_LEVEL || "").trim().toLowerCase();
  return LEVELS[raw] || LEVELS.info;
}

// Field names whose values are never printed. Substring matching, because the
// interesting cases are compounds: censusApiKey, x-cividian-key, set-cookie.
const SECRET_FIELD = /(secret|password|passwd|token|apikey|api_key|credential|cookie|authorization|bearer|session|receipt|base64|enrollment|confirmationcode)/i;

// A field named exactly "key" is a credential; "keyEnv" and "cacheKey" are not,
// and redacting them would hide the very thing an operator is debugging.
const EXACT_SECRET_FIELD = /^key$/i;

// Credential shapes this platform issues (cvd_sk_) or sends to vendors. Applied
// to string VALUES anywhere in the payload, including inside vendor error text.
const SECRET_VALUE = new RegExp(
  [
    "cvd_sk_[A-Za-z0-9_-]{8,}",
    "sk-[A-Za-z0-9_-]{16,}",
    "AIza[A-Za-z0-9_-]{16,}",
    "xai-[A-Za-z0-9_-]{16,}",
    "Bearer\\s+[A-Za-z0-9._~+/-]{16,}",
  ].join("|"),
  "g"
);

const REDACTED = "[redacted]";

// Optional PERSONAL-data masking, distinct from the credential scrubbing above.
// On by default; LOG_REDACT_PII=0 is an explicit operator opt-out. Kept inline (not imported from lib/privacy/pii.js)
// so this module keeps its no-import, no-cycle property. An email keeps its
// domain, a phone keeps its last two digits, so a line stays correlatable
// without carrying the identity. Read per call so a test can toggle it.
const PII_EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PII_PHONE = /(?<!\d)(\+?\d[\d\s().-]{6,}\d)(?!\d)/g;
function redactPiiEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.LOG_REDACT_PII || "true").trim());
}
function maskPii(s) {
  return s
    .replace(PII_EMAIL, (_m, first, domain) => first + "***" + domain)
    .replace(PII_PHONE, (m) => { const d = m.replace(/\D/g, ""); return d.length < 7 ? m : "***" + d.slice(-2); });
}

// Optional observers of emitted lines (lib/observability/handler.js registers
// one that turns lines into Sentry breadcrumbs). Kept as a plain array so this
// module still has no imports and can never form a cycle with its consumers.
const sinks = [];

// Register a sink. Returns an unsubscribe function.
export function addLogSink(fn) {
  if (typeof fn !== "function") return () => {};
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_STRING = 2000;

function scrubString(s) {
  const cut = s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "...[truncated]" : s;
  const noSecrets = cut.replace(SECRET_VALUE, REDACTED);
  // Opaque UUID correlation IDs are not telephone numbers.
  if(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(noSecrets))return noSecrets;
  return redactPiiEnabled() ? maskPii(noSecrets) : noSecrets;
}

// Bounded, cycle-safe, secret-scrubbing conversion to something JSON.stringify
// cannot choke on. Depth and width caps are not politeness; an unbounded walk
// over an object a vendor handed us is a memory and CPU path an attacker can
// influence.
function scrub(value, depth, seen) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string") return scrubString(value);
  if (t === "number") return Number.isFinite(value) ? value : String(value);
  if (t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return undefined;

  // An Error does not serialize through JSON.stringify: its message and stack
  // are non-enumerable, so the naive result is "{}". This is the single most
  // common field this logger will ever be handed, so it gets explicit handling.
  if (value instanceof Error) {
    return {
      message: scrubString(String(value.message || value)),
      name: value.name || "Error",
      // The stack is a debug-level luxury. It is long, it is noisy in a log
      // drain, and it occasionally contains a query string. Only at debug.
      stack: threshold() >= LEVELS.debug && value.stack ? scrubString(String(value.stack)) : undefined,
    };
  }
  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length && i < MAX_ARRAY; i++) {
        const v = scrub(value[i], depth + 1, seen);
        out.push(v === undefined ? null : v);
      }
      if (value.length > MAX_ARRAY) out.push("...[" + (value.length - MAX_ARRAY) + " more]");
      return out;
    }
    const out = {};
    for (const k of Object.keys(value)) {
      if (EXACT_SECRET_FIELD.test(k) || SECRET_FIELD.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      const v = scrub(value[k], depth + 1, seen);
      if (v !== undefined) out[k] = v;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function emit(level, component, evt, fields) {
  try {
    if (LEVELS[level] > threshold()) return;
    const line = { level, evt: String(evt) };
    if (component) line.component = component;
    const extra = fields ? scrub(fields, 0, new Set()) : null;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const k of Object.keys(extra)) {
        // The envelope owns these three names. A caller field of the same name
        // is kept rather than dropped, under a prefix, so a collision loses
        // nothing and cannot forge the level of a line.
        if (k === "level" || k === "evt" || k === "component") line["field_" + k] = extra[k];
        else line[k] = extra[k];
      }
    } else if (extra !== null) {
      line.detail = extra;
    }
    // See the header: stdout for every level, deliberately.
    console.log(JSON.stringify(line));
    // Sinks see the same scrubbed line that was printed, never the raw input,
    // so a sink cannot become a second path for a credential to leave the
    // process. A throwing sink is dropped for this line and never propagates.
    for (const sink of sinks) {
      try { sink(line); } catch (e2) { /* a sink must never take a request down */ }
    }
  } catch (e) {
    // Last resort. If even JSON.stringify failed, say so in a shape that is
    // still one line and still greppable, and never propagate.
    try {
      console.log('{"level":"error","evt":"LOG_EMIT_FAILED","component":' + JSON.stringify(String(component || "")) + "}");
    } catch (e2) {
      /* give up silently rather than crash a request */
    }
  }
}

// createLogger("api/v1") returns the four level methods plus child(), which
// binds fields that should appear on every line from a narrower scope (a
// capability id, a request id) without every call site repeating them.
export function createLogger(component, base) {
  const bound = base && typeof base === "object" ? base : null;
  function at(level) {
    return function (evt, fields) {
      const merged = bound ? Object.assign({}, bound, fields || {}) : fields;
      emit(level, component, evt, merged);
    };
  }
  return {
    error: at("error"),
    warn: at("warn"),
    info: at("info"),
    debug: at("debug"),
    child(extra) {
      return createLogger(component, Object.assign({}, bound || {}, extra || {}));
    },
  };
}

// For a caller that has no natural component name. Prefer createLogger.
export const log = createLogger(null);

// Exported for the test suite so the redaction rules are asserted directly
// rather than inferred from a captured line.
export const __test = { scrub, LEVELS };
