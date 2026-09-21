// Share one inference ledger between the main site and the public judging host.
// Account records and briefs continue using each host's own REDIS_URL.
import { createClient } from 'redis';
import { getRedis } from '../redis.js';

let client, connecting, failedUntil = 0;
export async function getBudgetRedis() {
  const url = process.env.DILIGENCE_BUDGET_REDIS_URL;
  if (!url) return getRedis();
  if (client?.isReady) return client;
  if (Date.now() < failedUntil) return null;
  if (connecting) return connecting;
  connecting = (async () => {
    const candidate = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 256, socket: { connectTimeout: 1500, reconnectStrategy: false } });
    candidate.on('error', () => {});
    try { await candidate.connect(); client = candidate; return client; }
    catch { if (candidate.isOpen) await candidate.disconnect().catch(() => {}); failedUntil = Date.now() + 10000; return null; }
  })();
  try { return await connecting; } finally { connecting = null; }
}
