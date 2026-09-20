// Preview namespaces cover ordinary commands, transactions, Lua keys and scans.
// Unknown commands fail closed so a new command cannot silently escape isolation.
const clients = new WeakMap();
const singleKey = ['get', 'getDel', 'set', 'incr', 'incrBy', 'expire', 'pExpire', 'ttl', 'pTTL', 'type', 'hGetAll', 'hIncrBy', 'lRange', 'lPush', 'lRem', 'rPush', 'lTrim', 'sAdd', 'sCard'];
export function namespaceRedis(client, prefix = '') {
  if (!prefix) return client;
  if (!/^[a-zA-Z0-9:_-]{1,79}:$/.test(prefix)) throw new Error('invalid_redis_namespace');
  let byPrefix = clients.get(client);
  if (!byPrefix) { byPrefix = new Map(); clients.set(client, byPrefix); }
  if (byPrefix.has(prefix)) return byPrefix.get(prefix);
  const key = value => {
    if (typeof value !== 'string') throw new Error('invalid_redis_key');
    return prefix + value;
  };
  const keys = value => Array.isArray(value) ? value.map(key) : key(value);
  function commands(target, transaction = false) {
    const result = Object.create(null);
    for (const name of singleKey) result[name] = (first, ...args) => {
      const returned = target[name](key(first), ...args);
      return transaction ? result : returned;
    };
    for (const name of ['del', 'unlink', 'exists', 'mGet']) result[name] = first => {
      const returned = target[name](keys(first));
      return transaction ? result : returned;
    };
    result.eval = (script, options) => {
      if (!Array.isArray(options?.keys) || !options.keys.length) throw new Error('redis_lua_keys_required');
      const returned = target.eval(script, { ...options, keys: options.keys.map(key) });
      return transaction ? result : returned;
    };
    if (transaction) result.exec = () => target.exec();
    return result;
  }
  const result = commands(client);
  result.ping = () => client.ping();
  result.quit = () => client.quit();
  result.disconnect = () => client.disconnect();
  Object.defineProperties(result, { isOpen: { get: () => client.isOpen }, isReady: { get: () => client.isReady } });
  result.multi = () => commands(client.multi(), true);
  result.scanIterator = async function* (options = {}) {
    for await (const value of client.scanIterator({ ...options, MATCH: prefix + (options.MATCH || '*') })) {
      if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('redis_scan_outside_namespace');
      yield value.slice(prefix.length);
    }
  };
  byPrefix.set(prefix, result);
  return result;
}
