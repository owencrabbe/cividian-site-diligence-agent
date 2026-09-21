// Standalone managed accounts. Tokens stay in HttpOnly cookies and are checked
// with the configured provider; user metadata is display data, never authority.
import { createHash, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { getJSON, setJSON, compareSetJSON } from '../store.js';
import { StorageUnavailableError } from '../storage-policy.js';
import { siteOrigin, productionLike } from '../deployment.js';

const ACCESS = 'diligence_access', REFRESH = 'diligence_refresh', ATTEMPT = 'diligence_login';
const SESSION_SECONDS = 30 * 86400;
const digest = (s) => createHash('sha256').update(s).digest('hex');
export function accountConfig(env = process.env) {
  try {
    const url = new URL(env.DILIGENCE_SUPABASE_URL || '');
    const key = env.DILIGENCE_SUPABASE_PUBLISHABLE_KEY || '';
    if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return null;
    return { origin: url.origin, key, email: env.DILIGENCE_EMAIL_AUTH_ENABLED === 'true', google: env.DILIGENCE_GOOGLE_AUTH_ENABLED === 'true', github: env.DILIGENCE_GITHUB_AUTH_ENABLED === 'true' };
  } catch { return null; }
}
export function accountCapabilities() {
  const c = accountConfig();
  return { configured: !!c, email: !!c?.email, google: !!c?.google, github: !!c?.github };
}
export function readCookie(req, name) {
  const parts = String(req.headers?.cookie || '').split(';').map((p) => p.trim()).filter((p) => p.startsWith(name + '='));
  if (parts.length !== 1) return null;
  try { return decodeURIComponent(parts[0].slice(name.length + 1)); } catch { return null; }
}
export function appendCookie(res, name, value, age) {
  const prior = res.getHeader?.('Set-Cookie');
  const list = Array.isArray(prior) ? prior : prior ? [prior] : [];
  const secure = productionLike() || /^https:/.test(process.env.SITE_URL || '');
  res.setHeader('Set-Cookie', [...list, name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '')]);
  res.setHeader('Cache-Control', 'private, no-store');
}
function setProviderCookies(res, session) {
  appendCookie(res, ACCESS, session.access_token, SESSION_SECONDS);
  appendCookie(res, REFRESH, session.refresh_token, SESSION_SECONDS);
  appendCookie(res, 'pago_session', '', 0);
}
export function hasAccountCookies(req) {
  return String(req.headers?.cookie || '').split(';').some((p) => [ACCESS, REFRESH].some((key) => p.trim().startsWith(key + '=')));
}
export async function providerRequest(route, { body, access, method, config = accountConfig() } = {}) {
  if (!config) throw new StorageUnavailableError();
  let res;
  try {
    res = await fetch(config.origin + '/auth/v1/' + route, { method: method || (body ? 'POST' : 'GET'), redirect: 'error', signal: AbortSignal.timeout(8000), headers: { apikey: config.key, 'content-type': 'application/json', ...(access ? { Authorization: 'Bearer ' + access } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new StorageUnavailableError(); }
  if (res.status >= 500) throw new StorageUnavailableError();
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}
function principal(user, access) {
  const config = accountConfig();
  if (!config || !user?.email || !user.email_confirmed_at || user.is_anonymous || !/^[a-f0-9-]{36}$/.test(user.id || '')) return null;
  let claims; try { claims = decodeJwt(access); } catch { return null; }
  if (claims.sub !== user.id || claims.iss !== config.origin + '/auth/v1' || claims.aud !== 'authenticated' || typeof claims.session_id !== 'string' || !/^[a-f0-9-]{36}$/.test(claims.session_id) || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) return null;
  return { typ: 'diligence-account', diligenceAccountId: digest(config.origin + '|' + user.id), sub: user.id, jti: claims.session_id, exp: claims.exp, verified: true, email: user.email.slice(0, 254), name: String(user.user_metadata?.name || user.email).slice(0, 100) };
}
export const accountRecordKey = (id) => 'pago:diligence:account:' + id;
export async function ensureAccount(session) {
  const key = accountRecordKey(session.diligenceAccountId);
  for (let i = 0; i < 8; i++) {
    const before = await getJSON(key);
    if (before?.active === false) return false;
    if (before?.active === true) return true;
    if (await compareSetJSON(key, before, { schema: 'diligence.account.v1', id: session.diligenceAccountId, active: true, createdAt: new Date().toISOString() })) return true;
  }
  throw new StorageUnavailableError();
}
export async function acceptProviderSession(res, data) {
  if (typeof data?.access_token !== 'string' || typeof data?.refresh_token !== 'string' || data.access_token.length > 16000 || data.refresh_token.length > 4096) return null;
  const checked = await providerRequest('user', { access: data.access_token });
  const session = checked.ok ? principal(checked.data, data.access_token) : null;
  if (!session || !await ensureAccount(session)) return null;
  if (await getJSON('pago:diligence:logged-out:' + session.jti)) return null;
  setProviderCookies(res, data);
  return session;
}
export async function getAccountSession(req) {
  if (!hasAccountCookies(req)) return null;
  if (req.diligenceAccountPromise) return req.diligenceAccountPromise;
  req.diligenceAccountPromise = (async () => {
    const access = readCookie(req, ACCESS), refresh = readCookie(req, REFRESH);
    const ended = { signInRequired: true };
    if (!accountConfig() || !access || !refresh) return ended;
    const checked = await providerRequest('user', { access });
    if (checked.status === 429) throw new StorageUnavailableError();
    let session = checked.ok ? principal(checked.data, access) : null;
    // Network and provider outages throw; only a refused/expired token rotates.
    if (!session && (checked.ok || [401, 403].includes(checked.status)) && req.authResponse) {
      const rotated = await providerRequest('token?grant_type=refresh_token', { body: { refresh_token: refresh } });
      if (!rotated.ok) return ended;
      session = await acceptProviderSession(req.authResponse, rotated.data);
    }
    if (!session || await getJSON('pago:diligence:logged-out:' + session.jti)) return ended;
    if (!(await getJSON(accountRecordKey(session.diligenceAccountId)))?.active) return ended;
    return session;
  })();
  return req.diligenceAccountPromise;
}
export async function endAccountSession(req, res) {
  let providerRevoked = true;
  try {
    const session = await getAccountSession(req);
    if (session?.diligenceAccountId) await setJSON('pago:diligence:logged-out:' + session.jti, { revoked: true }, SESSION_SECONDS);
    const access = readCookie(req, ACCESS);
    if (access && accountConfig()) { const r = await providerRequest('logout?scope=local', { access, method: 'POST' }); providerRevoked = r.ok || [401, 403].includes(r.status); }
  } catch { providerRevoked = false; }
  finally {
    appendCookie(res, ACCESS, '', 0); appendCookie(res, REFRESH, '', 0); appendCookie(res, ATTEMPT, '', 0); appendCookie(res, 'pago_session', '', 0);
  }
  return providerRevoked;
}
export async function beginLogin(req, res, { email, provider }) {
  const config = accountConfig();
  if (!config || (provider ? !['google', 'github'].includes(provider) || !config[provider] : !config.email)) return { ok: false, error: 'login_unavailable', note: 'This sign-in method is not enabled yet. You can use the guest app.' };
  const nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = siteOrigin() + '/api/account?action=callback&state=' + nonce;
  await setJSON('pago:diligence:login:' + digest(nonce), { email: email || null, verifier, provider: provider || 'email', expiresAt: Date.now() + 600000 }, 600);
  if (!provider) {
    const r = await providerRequest('otp', { body: { email, create_user: true, code_challenge: challenge, code_challenge_method: 's256' } });
    if (!r.ok) return { ok: false, error: r.status === 429 ? 'rate_limited' : 'login_unavailable', note: 'A sign-in code could not be sent. Wait a minute and try again.' };
  }
  appendCookie(res, ATTEMPT, nonce, 600);
  return provider ? { ok: true, url: config.origin + '/auth/v1/authorize?' + new URLSearchParams({ provider, redirect_to: callback, code_challenge: challenge, code_challenge_method: 's256' }) } : { ok: true, note: 'Check your email for a sign-in code. It expires in 10 minutes.' };
}
export async function finishLogin(req, res, { code, state, oauth }) {
  const nonce = readCookie(req, ATTEMPT);
  if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || (oauth && state !== nonce)) return null;
  const key = 'pago:diligence:login:' + digest(nonce);
  let attempt = await getJSON(key);
  if (!attempt || attempt.used || attempt.expiresAt < Date.now() || (oauth ? attempt.provider === 'email' : attempt.provider !== 'email')) return null;
  if ((attempt.attempts || 0) >= 5) return null;
  const counted = { ...attempt, attempts: (attempt.attempts || 0) + 1 };
  if (!await compareSetJSON(key, attempt, counted)) return null;
  attempt = counted;
  // The explicit expiry remains authoritative even if the TTL write fails.
  const { store } = await import('../store.js');
  await store().expire(key, Math.max(1, Math.ceil((attempt.expiresAt - Date.now()) / 1000)));
  const result = oauth ? await providerRequest('token?grant_type=pkce', { body: { auth_code: code, code_verifier: attempt.verifier } }) : await providerRequest('verify', { body: { email: attempt.email, token: code, type: 'email' } });
  if (!result.ok) return null;
  if (!await compareSetJSON(key, attempt, { used: true, expiresAt: attempt.expiresAt })) return null;
  await setJSON(key, { used: true }, 600);
  const session = await acceptProviderSession(res, result.data);
  appendCookie(res, ATTEMPT, '', 0);
  return session;
}
