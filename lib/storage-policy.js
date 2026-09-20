// @ts-check
import { productionLike } from './deployment.js';

export class StorageUnavailableError extends Error {
  constructor() { super('Durable storage is unavailable. Retry when the service recovers.'); this.name = 'StorageUnavailableError'; }
}

// A configured-but-unreachable Redis is an outage, even on a developer machine.
// Never cross from that store into a second, silently divergent account store.
export function localMemoryAllowed() { return !process.env.REDIS_URL && !productionLike(); }
export function requireLocalMemory() { if (!localMemoryAllowed()) throw new StorageUnavailableError(); }

/** @param {(req: any, res: any) => Promise<any>} handler */
export function withStorageBoundary(handler) {
  return async (req, res) => {
    try { return await handler(req, res); }
    catch (error) {
      if (!(error instanceof StorageUnavailableError)) throw error;
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Retry-After', '10');
      return res.status(503).json({ ok: false, error: 'storage_unavailable', authed: false, message: 'Account storage is temporarily unavailable. Your request was not confirmed; retry after the service recovers.' });
    }
  };
}
