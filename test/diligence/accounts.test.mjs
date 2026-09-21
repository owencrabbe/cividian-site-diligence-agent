// Synthetic managed identity and credentials only. No network or provider costs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import * as auth from '../../lib/diligence/account-auth.js';
import * as keys from '../../lib/diligence/access-keys.js';
import { invokeIntegration } from '../../lib/diligence/integrations.js';
import { getJSON, setJSON } from '../../lib/store.js';
import { ownerKey, startRun } from '../../lib/diligence/brief.js';
import { deps, siteFor, SITE_INPUT } from './helpers.mjs';
import account from '../../api/diligence-account.js';
import publicApi from '../../api/diligence-public.js';
import mcp from '../../api/diligence-mcp.js';
import { createServer } from '../../lib/diligence/standalone-server.mjs';
const original = { ...process.env }, realFetch = globalThis.fetch;
const project = 'https://syntheticaccounts.supabase.co', base = 'http://localhost:3456';
const user = () => ({ id: randomUUID(), email: 'synthetic@example.test', email_confirmed_at: new Date().toISOString(), user_metadata: { name: 'Synthetic', admin: true, diligenceAccountId: 'forged' } });
const res = () => ({ code: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; }, end() { return this; }, redirect(n, to) { this.code = n; this.headers.location = to; return this; } });
const request = (url, { method = 'GET', body = {}, cookie, bearer, origin = base, ...headers } = {}) => ({ url, method, body, headers: { host: 'localhost:3456', origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers }, socket: { remoteAddress: '127.0.0.1' } });
function cookies(response) { return (response.getHeader('set-cookie') || []).map((s) => s.split(';')[0]).join('; '); }
async function sessionFor(person = user(), overrides = {}) {
  const access_token = await new SignJWT({ sub: person.id, iss: project + '/auth/v1', aud: 'authenticated', session_id: randomUUID(), exp: Math.floor(Date.now() / 1000) + 600, ...overrides }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('synthetic-provider-token-secret-only-tests'));
  return { access_token, refresh_token: 'synthetic-refresh-' + randomUUID(), person };
}
function provider(data, failures = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    assert.ok(String(url).startsWith(project + '/auth/v1/'), 'only the synthetic provider can be called');
    const route = String(url).slice((project + '/auth/v1/').length); calls.push({ route, body: opts.body ? JSON.parse(opts.body) : null });
    if (failures.throw) throw new Error('synthetic outage');
    if (failures.status) return Response.json({}, { status: failures.status });
    if (route === 'user') return Response.json(data.person);
    if (route.startsWith('logout')) return new Response(null, { status: 204 });
    if (route === 'otp') return Response.json({});
    return Response.json(data);
  };
  return calls;
}
async function identity() { const data = await sessionFor(); provider(data); const response = res(); const session = await auth.acceptProviderSession(response, data); assert.ok(session); return { data, session, cookie: cookies(response) }; }
before(() => {
  for (const k of Object.keys(process.env)) if (/^(NEBIUS_|CENSUS_|REDIS_|DATABASE_|AI_|DILIGENCE_|VERCEL|NODE_ENV$|AUTH_SECRET$)/.test(k)) delete process.env[k];
  Object.assign(process.env, { AUTH_SECRET: 'synthetic-account-tests-secret-0123456789', SITE_URL: base, DILIGENCE_SUPABASE_URL: project, DILIGENCE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic', DILIGENCE_EMAIL_AUTH_ENABLED: 'true', DILIGENCE_GITHUB_AUTH_ENABLED: 'true', DILIGENCE_FIXTURE_MODE: '1' });
});
after(() => { globalThis.fetch = realFetch; for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]; Object.assign(process.env, original); });

test('managed identity uses provider-verified stable IDs; metadata and wrong issuer cannot authorize', async () => {
  const { session, cookie, data } = await identity();
  assert.equal(session.diligenceAccountId, createHash('sha256').update(project + '|' + data.person.id).digest('hex'));
  assert.equal(ownerKey(session).key, 'acct:diligence:' + session.diligenceAccountId);
  assert.ok(await auth.getAccountSession(request('/', { cookie })));
  for (const override of [{ iss: 'https://other.supabase.co/auth/v1' }, { sub: randomUUID() }, { aud: 'anon' }, { exp: 1 }, { session_id: 'bad' }]) {
    const invalid = await sessionFor(data.person, override); provider(invalid); assert.equal(await auth.acceptProviderSession(res(), invalid), null);
  }
  const unverified = await sessionFor({ ...user(), email_confirmed_at: null }); provider(unverified); assert.equal(await auth.acceptProviderSession(res(), unverified), null);
  assert.equal(auth.accountConfig({ DILIGENCE_SUPABASE_URL: 'https://evil.example', DILIGENCE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic' }), null);
  assert.equal(auth.readCookie({ headers: { cookie: 'diligence_access=a; diligence_access=b' } }, 'diligence_access'), null);
});

test('provider sessions rotate through HttpOnly cookies and outages never downgrade to guest', async () => {
  const { data, cookie } = await identity();
  const rotated = await sessionFor(data.person); let calls = 0;
  globalThis.fetch = async (url) => { if (String(url).endsWith('/user') && calls++ === 0) return Response.json({}, { status: 401 }); return Response.json(String(url).endsWith('/user') ? rotated.person : rotated); };
  const response = res(), req = request('/', { cookie }); req.authResponse = response;
  const session = await auth.getAccountSession(req); assert.ok(session.diligenceAccountId);
  assert.ok(response.getHeader('set-cookie').every((s) => /HttpOnly; SameSite=Lax/.test(s)));
  provider(data, { throw: true }); await assert.rejects(auth.getAccountSession(request('/', { cookie })), { name: 'StorageUnavailableError' });
  const out = res(); await account(request('/api/account', { cookie }), out); assert.equal(out.code, 503);
  const loggedOut = res(); assert.equal(await auth.endAccountSession(request('/', { cookie }), loggedOut), false); assert.equal(loggedOut.getHeader('set-cookie').filter((s) => /Max-Age=0/.test(s)).length, 4);
});

test('email code and OAuth attempts bind to a browser and PKCE, then reject replays', async () => {
  const data = await sessionFor(); const calls = provider(data), start = res();
  assert.equal((await auth.beginLogin(request('/'), start, { email: data.person.email })).ok, true);
  assert.equal(calls[0].route, 'otp'); assert.equal(calls[0].body.code_challenge_method, 's256'); assert.equal(calls[0].body.code_challenge.length, 43);
  assert.equal(await auth.finishLogin(request('/'), res(), { code: '123456' }), null);
  const cookie = cookies(start); assert.ok(await auth.finishLogin(request('/', { cookie }), res(), { code: '123456' }));
  assert.equal(await auth.finishLogin(request('/', { cookie }), res(), { code: '123456' }), null);
  const oauth = res(), result = await auth.beginLogin(request('/'), oauth, { provider: 'github' });
  const redirect = new URL(new URL(result.url).searchParams.get('redirect_to')); const state = redirect.searchParams.get('state');
  assert.equal(redirect.origin, base); assert.equal(await auth.finishLogin(request('/', { cookie: cookies(oauth) }), res(), { code: 'synthetic-code', oauth: true, state: 'wrong' }), null);
  assert.ok(await auth.finishLogin(request('/', { cookie: cookies(oauth) }), res(), { code: 'synthetic-code', oauth: true, state }));
  const exchange = calls.find((c) => c.route === 'token?grant_type=pkce'); assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), new URL(result.url).searchParams.get('code_challenge'));
});

test('logout marks the session revoked; disabled accounts cannot revive or use keys', async () => {
  const { session, cookie, data } = await identity();
  const key = await keys.createAccessKey(session, { label: 'Disable test', scopes: ['diligence:read'] });
  assert.equal(await auth.endAccountSession(request('/', { cookie }), res()), true);
  assert.equal((await auth.getAccountSession(request('/', { cookie }))).signInRequired, true);
  assert.equal(await auth.acceptProviderSession(res(), data), null);
  await setJSON(auth.accountRecordKey(session.diligenceAccountId), { active: false });
  assert.equal(await keys.authenticateAccessKey(request('/', { bearer: key.key })), null);
  assert.equal(await auth.ensureAccount(session), false);
});

test('keys store hashes only, enforce scopes and owner isolation, and revoke immediately', async () => {
  const a = await identity(), b = await identity();
  const created = await keys.createAccessKey(a.session, { label: '<script>connection</script>', scopes: ['diligence:read'] }); assert.equal(created.ok, true);
  assert.match(created.key, /^cvd_dlg_[A-Za-z0-9_-]{43}$/);
  const digest = createHash('sha256').update(created.key).digest('hex');
  assert.ok(!JSON.stringify(await getJSON('pago:diligence:apikey:' + digest)).includes(created.key));
  assert.ok(!JSON.stringify(await keys.listAccessKeys(a.session)).includes(created.key));
  assert.equal((await keys.listAccessKeys(b.session)).length, 0);
  assert.equal(await keys.revokeAccessKey(b.session, created.metadata.id), false);
  const principal = await keys.authenticateAccessKey(request('/', { bearer: created.key })); assert.equal(principal.owner, a.session.diligenceAccountId);
  assert.equal((await invokeIntegration(principal, 'cividian_create_brief', { query: SITE_INPUT.query })).status, 403);
  assert.equal((await invokeIntegration(principal, 'cividian_get_brief', { id: 'dlg_' + 'a'.repeat(24), owner: b.session.diligenceAccountId })).status, 400);
  assert.equal(await keys.revokeAccessKey(a.session, created.metadata.id), true);
  assert.equal(await keys.authenticateAccessKey(request('/', { bearer: created.key })), null);
});

test('concurrent issuance never exceeds five active keys; expired keys and cookie-only API access fail', async () => {
  const { session } = await identity();
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => keys.createAccessKey(session, { label: 'Concurrent ' + i, scopes: ['diligence:read'] })));
  assert.equal(attempts.filter((a) => a.ok).length, 5);
  const raw = attempts.find((a) => a.ok).key, digest = createHash('sha256').update(raw).digest('hex'), stored = await getJSON('pago:diligence:apikey:' + digest);
  await setJSON('pago:diligence:apikey:' + digest, { ...stored, expiresAt: 1 });
  assert.equal(await keys.authenticateAccessKey(request('/', { bearer: raw })), null);
  assert.equal(await keys.authenticateAccessKey(request('/', { cookie: 'pago_session=' + raw })), null);
  assert.equal((await keys.createAccessKey({ guest: true }, { label: 'Invalid', scopes: ['diligence:read'] })).error, 'account_required');
});

test('REST and MCP return the same owned brief and conceal another account brief', async () => {
  const a = await identity(), b = await identity(), key = await keys.createAccessKey(a.session, { label: 'Integration', scopes: ['diligence:read'] });
  const principal = await keys.authenticateAccessKey(request('/', { bearer: key.key })); const d = deps(), site = await siteFor(SITE_INPUT, d);
  const own = await startRun({ site, objective: 'residential_infill', assumptions: {} }, ownerKey(a.session), d);
  const other = await startRun({ site, objective: 'residential_infill', assumptions: {} }, ownerKey(b.session), d);
  const out = res(); await publicApi(request('/api/v1/briefs/' + own.brief.id, { bearer: key.key }), out); assert.equal(out.code, 200); assert.deepEqual(out.body.brief.owner, { kind: 'account' });
  assert.equal((await invokeIntegration(principal, 'cividian_get_brief', { id: other.brief.id })).status, 404);
  const mc = res(); await mcp(request('/api/mcp', { method: 'POST', bearer: key.key, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cividian_get_brief', arguments: { id: own.brief.id } } } }), mc);
  assert.deepEqual(mc.body.result.structuredContent, out.body);
  for (const entry of [publicApi, mcp]) { const denied = res(); await entry(request('/api/mcp', { method: 'POST', cookie: a.cookie }), denied); assert.equal(denied.code, 401); }
  const cross = res(); await publicApi(request('/api/v1/briefs', { bearer: key.key, origin: 'https://foreign.example' }), cross); assert.equal(cross.code, 403);
});

test('MCP negotiates legacy and modern metadata, exposes only authorized tools and rejects mismatches', async () => {
  const { session } = await identity(), key = await keys.createAccessKey(session, { label: 'Protocol', scopes: ['diligence:read'] });
  const call = async (method, params = {}, headers = {}) => { const output = res(); await mcp(request('/api/mcp', { method: 'POST', bearer: key.key, body: { jsonrpc: '2.0', id: 1, method, params }, ...headers }), output); return output; };
  assert.equal((await call('initialize', { protocolVersion: '2025-11-25' })).body.result.protocolVersion, '2025-11-25');
  assert.equal((await call('tools/list')).body.result.tools.some((t) => t.name === 'cividian_create_brief'), false);
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' };
  const modern = await call('server/discover', { _meta }, headers); assert.equal(modern.code, 200); assert.equal(modern.body.result.resultType, 'complete'); assert.equal(modern.body.result.cacheScope, 'private');
  assert.equal((await call('server/discover', { _meta }, { ...headers, 'mcp-method': 'tools/call' })).body.error.code, -32020);
  assert.equal((await call('tools/list', {}, { 'mcp-protocol-version': 'unknown' })).body.error.code, -32022);
  assert.equal((await call('tools/call', { name: 'cividian_create_brief', arguments: { query: '123 Main St' } })).body.result.structuredContent.error, 'insufficient_scope');
});

test('account controls enforce same origin and deny guest key creation', async () => {
  const cross = res(); await account(request('/api/account?action=create-key', { method: 'POST', origin: 'https://foreign.example' }), cross); assert.equal(cross.code, 403);
  const guest = res(); await account(request('/api/account?action=create-key', { method: 'POST', body: { label: 'No', scopes: ['diligence:read'] } }), guest); assert.equal(guest.code, 401);
  const invalid = res(); await account(request('/api/account?action=oauth', { method: 'POST', body: {} }), invalid); assert.equal(invalid.code, 400);
});

test('standalone routing serves separate website, app, account and MCP; stale accounts cannot mint a guest', async () => {
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port; const prior = process.env.SITE_URL; process.env.SITE_URL = origin;
  try {
    for (const path of ['/', '/app', '/login', '/account', '/developers', '/manifest.webmanifest', '/sw.js', '/diligence-shared.css', '/app-icon.svg']) assert.equal((await realFetch(origin + path)).status, 200, path);
    const stale = await realFetch(origin + '/api/guest', { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: 'diligence_access=expired; diligence_refresh=expired' }, body: '{}' }); assert.equal(stale.status, 409);
    const malformed = await realFetch(origin + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }); assert.equal((await malformed.json()).error.code, -32700);
    const noAuth = await realFetch(origin + '/api/v1/briefs'); assert.equal(noAuth.status, 401);
    const text = await realFetch(origin + '/api/account?action=oauth', { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: 'provider=github' }); assert.equal(text.status, 415);
  } finally { process.env.SITE_URL = prior; await new Promise((resolve) => server.close(resolve)); }
});

test('HTTP login, account cookies, key issuance, REST, MCP and revocation work together', async () => {
  const data = await sessionFor(); provider(data);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, prior = process.env.SITE_URL; process.env.SITE_URL = origin;
  let cookie = '';
  async function call(path, body, extra = {}) {
    const response = await realFetch(origin + path, { method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', cookie, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const jar = new Map(cookie.split('; ').filter(Boolean).map((s) => [s.split('=')[0], s]));
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; jar.set(part.split('=')[0], part); }
    cookie = [...jar.values()].join('; ');
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await call('/api/account?action=send-code', { email: data.person.email })).status, 200);
    assert.equal((await call('/api/account?action=verify-code', { code: '123456' })).status, 200);
    const status = await call('/api/diligence'); assert.equal(status.body.session.kind, 'account'); assert.equal(status.body.session.verified, true);
    const made = await call('/api/account?action=create-key', { label: 'HTTP synthetic integration', scopes: ['diligence:read'] }); assert.equal(made.status, 201);
    const bearer = { authorization: 'Bearer ' + made.body.key };
    assert.equal((await call('/api/v1/briefs')).status, 401);
    assert.equal((await call('/api/v1/briefs', null, bearer)).status, 200);
    const rpc = await call('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, bearer); assert.equal(rpc.status, 200); assert.equal(rpc.body.result.tools.length, 4);
    assert.equal((await call('/api/account?action=revoke-key', { id: made.body.metadata.id })).status, 200);
    assert.equal((await call('/api/v1/briefs', null, bearer)).status, 401);
    assert.equal((await call('/api/account?action=logout', {})).status, 200);
    assert.equal((await call('/api/account')).body.user, null);
  } finally { process.env.SITE_URL = prior; await new Promise((resolve) => server.close(resolve)); }
});

test('login attempts stop after five failed codes even across different IPs', async () => {
  const data = await sessionFor(); provider(data); const response = res();
  await auth.beginLogin(request('/'), response, { email: data.person.email });
  const cookie = cookies(response); let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}, { status: 400 }); };
  for (let i = 0; i < 10; i++) assert.equal(await auth.finishLogin(request('/', { cookie }), res(), { code: '000000' }), null);
  assert.equal(calls, 5);
});

test('integration quotas are shared across keys and refuse excess creates', async () => {
  const { session } = await identity(); const principal = { owner: session.diligenceAccountId };
  for (let i = 0; i < 6; i++) assert.equal((await keys.integrationLimit(principal, true)).ok, true);
  assert.equal((await keys.integrationLimit(principal, true)).ok, false);
});
