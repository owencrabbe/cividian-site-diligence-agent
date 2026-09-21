import { readBody } from '../lib/http.js';
import { rateLimit, sameOrigin, tooMany } from '../lib/security.js';
import { withStorageBoundary } from '../lib/storage-policy.js';
import { authenticateAccessKey } from '../lib/diligence/access-keys.js';
import { invokeIntegration, openapiDocument } from '../lib/diligence/integrations.js';
import { siteOrigin } from '../lib/deployment.js';

export default withStorageBoundary(async function publicApi(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.headers.origin !== undefined && !sameOrigin(req)) return res.status(403).json({ ok: false, error: 'origin_refused' });
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/openapi.json') return res.json(openapiDocument(siteOrigin()));
  const limit = await rateLimit(req, 'diligence-integration-ip', 180, 60); if (!limit.ok) return tooMany(res, limit);
  const principal = await authenticateAccessKey(req);
  if (!principal) { res.setHeader('WWW-Authenticate', 'Bearer realm="Cividian Site Diligence"'); return res.status(401).json({ ok: false, error: 'invalid_api_key' }); }
  const routes = { 'GET /api/v1/capabilities': 'cividian_capabilities', 'POST /api/v1/sites/resolve': 'cividian_resolve_site', 'POST /api/v1/briefs': 'cividian_create_brief', 'GET /api/v1/briefs': 'cividian_list_briefs' };
  let name = routes[req.method + ' ' + url.pathname], args = {};
  const match = /^\/api\/v1\/briefs\/(dlg_[a-f0-9]{24})$/.exec(url.pathname);
  if (req.method === 'GET' && match) { name = 'cividian_get_brief'; args = { id: match[1] }; }
  if (!name) return res.status(404).json({ ok: false, error: 'not_found' });
  if (req.method === 'POST') {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ ok: false, error: 'json_required' });
    args = await readBody(req);
  }
  if (Buffer.byteLength(JSON.stringify(args)) > 16384) return res.status(413).json({ ok: false, error: 'request_too_large' });
  const result = await invokeIntegration(principal, name, args);
  if (result.status === 429) res.setHeader('Retry-After', String(result.body.retryAfter));
  return res.status(result.status).json(result.body);
});
