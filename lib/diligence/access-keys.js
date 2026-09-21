// User-owned credentials for the standalone app, never the private product.
import { createHash, randomBytes } from 'node:crypto';
import { getJSON, compareSetJSON, store } from '../store.js';
import { accountRecordKey } from './account-auth.js';
import { StorageUnavailableError } from '../storage-policy.js';

const PREFIX = 'cvd_dlg_', LIFETIME = 90 * 86400, LIMIT = 5;
export const KEY_SCOPES = ['diligence:read', 'diligence:write'];
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const recordKey = (digest) => 'pago:diligence:apikey:' + digest;
const indexKey = (owner) => 'pago:diligence:apikeys:' + owner;
const active = (row) => !row.revoked && row.expiresAt > Date.now();
function ownerId(session) { return session?.typ === 'diligence-account' && session.verified === true && /^[a-f0-9]{64}$/.test(session.diligenceAccountId || '') ? session.diligenceAccountId : null; }
function metadata(row) { return { id: row.id, label: row.label, prefix: row.prefix, scopes: row.scopes, createdAt: row.createdAt, expiresAt: row.expiresAt, revoked: !!row.revoked }; }
export async function createAccessKey(session, options = {}) {
  const owner = ownerId(session);
  if (!owner || !(await getJSON(accountRecordKey(owner)))?.active) return { ok: false, error: 'account_required' };
  if (typeof options.label !== 'string' || !options.label.trim() || options.label.length > 60 || !Array.isArray(options.scopes) || !options.scopes.length || options.scopes.some((s) => !KEY_SCOPES.includes(s)) || !options.scopes.includes('diligence:read')) return { ok: false, error: 'invalid_key_options' };
  const raw = PREFIX + randomBytes(32).toString('base64url'), digest = hash(raw);
  const row = { schema: 'diligence.key.v1', id: digest.slice(0, 20), owner, digest, prefix: raw.slice(0, 14) + '…', label: options.label.trim(), scopes: [...new Set(options.scopes)], createdAt: Date.now(), expiresAt: Date.now() + LIFETIME * 1000, revoked: false };
  for (let i = 0; i < 10; i++) {
    const previous = await getJSON(indexKey(owner));
    const list = Array.isArray(previous) ? previous : [];
    if (list.filter(active).length >= LIMIT) return { ok: false, error: 'key_limit', note: 'Revoke a key before creating another. Each account can have five active keys.' };
    const retained = [...list.filter(active), ...list.filter((r) => !active(r)).slice(-14), row];
    if (await compareSetJSON(indexKey(owner), previous, retained, { key: recordKey(digest), value: row })) {
      await store().expire(recordKey(digest), LIFETIME);
      return { ok: true, key: raw, metadata: metadata(row) };
    }
  }
  throw new StorageUnavailableError();
}
export async function listAccessKeys(session) {
  const owner = ownerId(session); if (!owner) return [];
  const list = await getJSON(indexKey(owner));
  return (Array.isArray(list) ? list : []).map(metadata);
}
export async function revokeAccessKey(session, id) {
  const owner = ownerId(session); if (!owner || !/^[a-f0-9]{20}$/.test(id || '')) return false;
  for (let i = 0; i < 10; i++) {
    const before = await getJSON(indexKey(owner)), list = Array.isArray(before) ? before : [];
    const match = list.find((row) => row.id === id);
    if (!match) return false;
    if (match.revoked) return true;
    const revoked = { ...match, revoked: true };
    if (await compareSetJSON(indexKey(owner), before, list.map((row) => row.id === id ? revoked : row), { key: recordKey(match.digest), value: revoked })) {
      await store().expire(recordKey(match.digest), Math.max(60, Math.ceil((match.expiresAt - Date.now()) / 1000)));
      return true;
    }
  }
  throw new StorageUnavailableError();
}
export async function authenticateAccessKey(req) {
  const auth = req.headers?.authorization;
  if (typeof auth !== 'string' || !/^Bearer cvd_dlg_[A-Za-z0-9_-]{43}$/.test(auth)) return null;
  const row = await getJSON(recordKey(hash(auth.slice(7))));
  if (!row || !active(row) || !/^[a-f0-9]{64}$/.test(row.owner || '') || !(await getJSON(accountRecordKey(row.owner)))?.active) return null;
  return { id: row.id, owner: row.owner, scopes: row.scopes.filter((s) => KEY_SCOPES.includes(s)), session: { typ: 'diligence-account', verified: true, diligenceAccountId: row.owner } };
}
export async function integrationLimit(principal, write) {
  const windows = write ? [[60, 6], [86400, 50]] : [[60, 120]];
  for (const [seconds, maximum] of windows) {
    const bucket = 'pago:rl:diligence-user:' + principal.owner + ':' + (write ? 'write' : 'read') + ':' + seconds + ':' + Math.floor(Date.now() / (seconds * 1000));
    const count = await store().incr(bucket);
    if (count === 1) await store().expire(bucket, seconds * 2);
    if (count > maximum) return { ok: false, retryAfter: seconds, note: write ? 'Brief creation limit reached. Try again later.' : 'Request limit reached. Try again shortly.' };
  }
  return { ok: true };
}
