import { readBody, query } from '../lib/http.js';
import { rateLimit, sameOrigin, tooMany } from '../lib/security.js';
import { withStorageBoundary } from '../lib/storage-policy.js';
import { accountCapabilities, getAccountSession, beginLogin, finishLogin, endAccountSession } from '../lib/diligence/account-auth.js';
import { createAccessKey, listAccessKeys, revokeAccessKey } from '../lib/diligence/access-keys.js';

export default withStorageBoundary(async function account(req, res) {
  req.authResponse = res;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const q = query(req), action = q.action || 'status';
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  const expected = ['status', 'keys', 'callback'].includes(action) ? 'GET' : 'POST';
  if (req.method !== expected) return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (req.method === 'POST' && !sameOrigin(req)) return res.status(403).json({ ok: false, error: 'origin_refused' });
  const limited = await rateLimit(req, 'diligence-account-' + (['status', 'keys'].includes(action) ? 'read' : 'write'), ['status', 'keys'].includes(action) ? 60 : 10, 60);
  if (!limited.ok) return tooMany(res, limited);
  if (action === 'callback') {
    const code = typeof q.code === 'string' && q.code.length < 2048 ? q.code : '';
    const session = code ? await finishLogin(req, res, { code, state: q.state, oauth: true }) : null;
    return res.redirect(303, session ? '/account' : '/login?error=sign_in_failed');
  }
  if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ ok: false, error: 'json_required' });
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 4096) return res.status(400).json({ ok: false, error: 'invalid_request' });
  if (action === 'send-code') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ ok: false, error: 'invalid_email', note: 'Enter a valid email address.' });
    const result = await beginLogin(req, res, { email });
    return res.status(result.ok ? 200 : 503).json(result);
  }
  if (action === 'verify-code') {
    if (!/^\d{6,10}$/.test(body.code || '')) return res.status(400).json({ ok: false, error: 'invalid_code', note: 'Enter the code from your email.' });
    const session = await finishLogin(req, res, { code: body.code });
    return res.status(session ? 200 : 400).json(session ? { ok: true } : { ok: false, error: 'invalid_code', note: 'That code is invalid or expired. Request another code and try again.' });
  }
  if (action === 'oauth') {
    if (!['google', 'github'].includes(body.provider)) return res.status(400).json({ ok: false, error: 'invalid_provider' });
    const result = await beginLogin(req, res, { provider: body.provider });
    return res.status(result.ok ? 200 : 503).json(result);
  }
  if (action === 'logout') { const providerRevoked = await endAccountSession(req, res); return res.json({ ok: true, providerRevoked }); }
  const session = await getAccountSession(req);
  const authed = !!session?.diligenceAccountId;
  if (action === 'status') return res.json({ ok: true, auth: accountCapabilities(), user: authed ? { name: session.name, email: session.email } : null, signInRequired: !!session?.signInRequired });
  if (!authed) return res.status(401).json({ ok: false, error: 'account_required', note: 'Sign in to manage your API keys.' });
  if (action === 'keys') return res.json({ ok: true, keys: await listAccessKeys(session) });
  if (action === 'create-key') { const result = await createAccessKey(session, body); return res.status(result.ok ? 201 : 400).json(result); }
  if (action === 'revoke-key') { const revoked = await revokeAccessKey(session, body.id); return res.status(revoked ? 200 : 404).json({ ok: revoked, ...(revoked ? {} : { error: 'not_found' }) }); }
  return res.status(400).json({ ok: false, error: 'unknown_action' });
});
