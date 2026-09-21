// One bounded capability registry for REST and MCP. No paid inference tools.
import { capabilities, startRun, listBriefs, loadBrief, ownerKey } from './brief.js';
import { resolveSite } from './site.js';
import { integrationLimit } from './access-keys.js';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const query = { type: 'string', minLength: 3, maxLength: 200, description: 'A US street address. A city name alone is not a site.' };
const id = { type: 'string', pattern: '^dlg_[a-f0-9]{24}$', description: 'A brief ID belonging to the authenticated account.' };
const input = object({ query, objective: { type: 'string', enum: ['residential_infill', 'mixed_use', 'adaptive_reuse'] }, assumptions: { type: 'object', maxProperties: 40, additionalProperties: { type: ['number', 'null'] }, description: 'Labeled screening inputs. Omitted values use stated defaults; null explicitly means unknown.' } }, ['query']);
export const INTEGRATIONS = [
  { name: 'cividian_capabilities', title: 'Available site diligence capabilities', scope: 'diligence:read', schema: object(), description: 'Read coverage, limitations, API capabilities and currently available interpretation. Does not start a run.' },
  { name: 'cividian_resolve_site', title: 'Find a property', scope: 'diligence:read', schema: object({ query }, ['query']), description: 'Resolve a US address to a point and candidate parcel. Read warnings; a nearby match is not a survey.' },
  { name: 'cividian_create_brief', title: 'Create a site diligence brief', scope: 'diligence:write', schema: input, description: 'Gather source records, compute labeled scenarios and save a new brief to your account. Uses rules-based priorities, not paid AI inference. Counts toward account creation limits.' },
  { name: 'cividian_list_briefs', title: 'List your saved briefs', scope: 'diligence:read', schema: object(), description: 'List only briefs owned by the authenticated account.' },
  { name: 'cividian_get_brief', title: 'Read a saved brief', scope: 'diligence:read', schema: object({ id }, ['id']), description: 'Read one account-owned brief with citations, assumptions, limitations and investigation steps. Null means unknown, never zero.' },
];
export function validateInput(schema, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((k) => !Object.hasOwn(schema.properties, k)) || schema.required.some((k) => !Object.hasOwn(value, k))) return false;
  for (const [key, val] of Object.entries(value)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof val !== 'string' || (rule.minLength && val.trim().length < rule.minLength) || (rule.maxLength && val.length > rule.maxLength) || (rule.pattern && !new RegExp(rule.pattern).test(val)) || (rule.enum && !rule.enum.includes(val)))) return false;
    if (rule.type === 'object' && (!val || typeof val !== 'object' || Array.isArray(val) || Object.keys(val).length > rule.maxProperties || Object.values(val).some((n) => n !== null && (typeof n !== 'number' || !Number.isFinite(n))))) return false;
  }
  return true;
}
function publicBrief(b) { if (!b) return b; const { owner: _owner, ...rest } = b; return { ...rest, owner: { kind: 'account' } }; }
export async function invokeIntegration(principal, name, args = {}) {
  const entry = INTEGRATIONS.find((t) => t.name === name);
  if (!entry) return { status: 404, body: { ok: false, error: 'unknown_tool' } };
  if (!principal.scopes.includes(entry.scope)) return { status: 403, body: { ok: false, error: 'insufficient_scope', requiredScope: entry.scope } };
  if (!validateInput(entry.schema, args)) return { status: 400, body: { ok: false, error: 'invalid_arguments', note: 'Use the published schema; extra properties and invalid values are refused.' } };
  const limit = await integrationLimit(principal, entry.scope === 'diligence:write');
  if (!limit.ok) return { status: 429, body: { ok: false, error: 'rate_limited', note: limit.note, retryAfter: limit.retryAfter } };
  const owner = ownerKey(principal.session);
  if (!owner) return { status: 401, body: { ok: false, error: 'account_required' } };
  if (name === 'cividian_capabilities') {
    const caps = await capabilities();
    return { status: 200, body: { ok: true, agentVersion: caps.agentVersion, scopes: principal.scopes, tools: INTEGRATIONS.filter((t) => principal.scopes.includes(t.scope)).map((t) => t.name), limits: { requestsPerMinute: 120, createsPerMinute: 6, createsPerDay: 50 }, inference: 'not_requested_by_integrations', note: 'Sources, deterministic scenarios and rules-based priorities. No paid model calls through API or MCP.' } };
  }
  if (name === 'cividian_resolve_site') return { status: 200, body: await resolveSite({ query: args.query }) };
  if (name === 'cividian_list_briefs') return { status: 200, body: { ok: true, briefs: await listBriefs(owner) } };
  if (name === 'cividian_get_brief') {
    const brief = await loadBrief(owner, args.id);
    return brief ? { status: 200, body: { ok: true, brief: publicBrief(brief) } } : { status: 404, body: { ok: false, error: 'not_found' } };
  }
  const site = await resolveSite({ query: args.query });
  if (!site.ok) return { status: 422, body: site };
  const result = await startRun({ site: site.site, objective: args.objective || 'residential_infill', assumptions: args.assumptions || {} }, owner);
  return { status: result.ok ? 201 : 422, body: result.ok ? { ok: true, id: result.brief.id, brief: publicBrief(result.brief) } : result };
}
export function openapiDocument(origin) {
  const operations = [ ['/capabilities', 'get', INTEGRATIONS[0]], ['/sites/resolve', 'post', INTEGRATIONS[1]], ['/briefs', 'post', INTEGRATIONS[2]], ['/briefs', 'get', INTEGRATIONS[3]], ['/briefs/{id}', 'get', INTEGRATIONS[4]] ];
  const paths = {};
  for (const [path, method, tool] of operations) {
    paths[path] ||= {};
    paths[path][method] = { operationId: tool.name, summary: tool.title, description: tool.description, security: [{ bearerKey: [] }], responses: { [method === 'post' && path === '/briefs' ? '201' : '200']: { description: 'Result in the ok/data envelope. Missing values remain null.' }, '401': { description: 'Invalid or expired key' }, '403': { description: 'Insufficient scope' }, '429': { description: 'Account or IP limit reached' } }, ...(method === 'post' ? { requestBody: { required: true, content: { 'application/json': { schema: tool.schema } } } } : path.includes('{id}') ? { parameters: [{ name: 'id', in: 'path', required: true, schema: id }] } : {}) };
  }
  return { openapi: '3.1.0', info: { title: 'Cividian Site Diligence API', version: '1.0.0' }, servers: [{ url: origin + '/api/v1' }], components: { securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', description: 'Create an expiring key in Account & connections. Store it in a secret manager.' } } }, paths };
}
