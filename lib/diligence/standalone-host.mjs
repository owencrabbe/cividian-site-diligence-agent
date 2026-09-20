// lib/diligence/standalone-host.mjs
// The host seam for the public submission edition. Everything the agent needs
// from the platform that has no account system behind it: the same request,
// origin, rate-limit, storage, and logging helpers Cividian uses (they depend
// on nothing private), plus a guest-only session implementation with the same
// cookie name, claims, and lifetime as lib/auth.js. No accounts, no email
// sign-in, no revocation registry: a guest session is the only credential.
//
// In the private product lib/diligence/host.js re-exports the real modules.
// In the public edition lib/diligence/host.js re-exports this file instead,
// and lib/auth.js is a one-line shim to it so api/guest.js runs unchanged.

export { rateLimit, sameOrigin, tooMany, forbidden, validRequestHost } from "../security.js";
export { readBody, methodGuard, query } from "../http.js";
export { withStorageBoundary } from "../storage-policy.js";
export { getJSON, setJSON } from "../store.js";
export { createLogger } from "../log.js";

import { SignJWT, jwtVerify } from "jose";
import { randomUUID, randomBytes } from "node:crypto";
import { productionLike } from "../deployment.js";

const COOKIE = "pago_session";
const ALG = "HS256";
let ephemeral = null;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (typeof s === "string" && s.trim().length >= 32) return new TextEncoder().encode(s.trim());
  if (productionLike()) throw new Error("AUTH_SECRET of at least 32 characters is required on a deployed host.");
  if (!ephemeral) {
    ephemeral = randomBytes(48).toString("hex");
    console.warn(JSON.stringify({ level: "warn", evt: "STANDALONE_EPHEMERAL_SECRET", note: "AUTH_SECRET is not set; using an ephemeral signing secret for this process only. Sessions will not survive a restart." }));
  }
  return new TextEncoder().encode(ephemeral);
}

export function authSecretStatus() {
  const s = process.env.AUTH_SECRET;
  return { mode: typeof s === "string" && s.trim().length >= 32 ? "configured" : productionLike() ? "missing" : "ephemeral" };
}

// Same claims as lib/auth.js: typ guest, guest true, no email, 24 hours.
export async function issueGuestToken() {
  return await new SignJWT({ typ: "guest", guest: true, name: "Guest", verified: false })
    .setProtectedHeader({ alg: ALG, typ: "cividian-guest+jwt" })
    .setSubject("guest")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret());
}

export async function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    return payload && payload.guest === true ? payload : null;
  } catch { return null; }
}

export async function getSession(req) {
  let token = null;
  const auth = req.headers && req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) token = auth.slice(7);
  if (!token && req.headers && req.headers.cookie) {
    const m = String(req.headers.cookie).match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
    if (m) { try { token = decodeURIComponent(m[1]); } catch { return null; } }
  }
  return verifyToken(token);
}

export function sessionGuest(session) { return !!(session && session.guest === true); }
export function sessionVerified() { return false; }
export function sessionSensitiveAllowed() { return false; }

export function setSessionCookie(res, token, maxAgeSec) {
  const secure = productionLike() || /^https:/.test(String(process.env.SITE_URL || ""));
  const parts = [COOKIE + "=" + encodeURIComponent(token), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + Math.max(60, Math.floor(Number(maxAgeSec) || 86400))];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}
