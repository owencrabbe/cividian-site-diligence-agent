// Owner-scoped atomic brief/index writes. Keep the original JSON keys so
// previously saved briefs remain readable. Local serialization mirrors Redis.
import { getRedis } from "../redis.js";
import { requireLocalMemory, StorageUnavailableError } from "../storage-policy.js";
import { getJSON, setJSON } from "./host.js";

const REMOVED = "diligence.deleted.v1";
const queues = new Map();
const SCRIPT = `
local current=redis.call('GET',KEYS[1])
local old=current and cjson.decode(current) or nil
if ARGV[1]=='save' and old and old.schema=='diligence.deleted.v1' then return -1 end
if ARGV[1]=='remove' and (not old or old.schema~='diligence.brief.v1') then return 0 end
local raw=redis.call('GET',KEYS[2])
local ids=raw and cjson.decode(raw) or {}
local next={}
if ARGV[1]=='save' then table.insert(next,ARGV[2]) end
for _,id in ipairs(ids) do
  if id~=ARGV[2] and #next<tonumber(ARGV[5]) then table.insert(next,id) end
end
if tonumber(ARGV[4])>0 then
  redis.call('SET',KEYS[1],ARGV[3],'EX',ARGV[4])
  redis.call('SET',KEYS[2],cjson.encode(next),'EX',ARGV[4])
else
  redis.call('SET',KEYS[1],ARGV[3])
  redis.call('SET',KEYS[2],cjson.encode(next))
end
return 1`;

function removed() { return Object.assign(new Error("Brief was removed."), { code: "brief_removed" }); }

async function change(owner, id, value, mode, maximum) {
  const keys = ["pago:diligence:brief:" + owner.key + ":" + id, "pago:diligence:index:" + owner.key];
  const ttl = owner.expiresAt ? Math.ceil((Date.parse(owner.expiresAt) - Date.now()) / 1000) : owner.ttl || 0;
  if (owner.expiresAt && ttl <= 0) throw Object.assign(new Error("Session expired."), { code: "session_expired" });
  const client = await getRedis();
  if (client) {
    let result;
    try { result = await client.eval(SCRIPT, { keys, arguments: [mode, id, JSON.stringify(value), String(ttl), String(maximum)] }); }
    catch { throw new StorageUnavailableError(); }
    if (result === -1) throw removed();
    return result === 1;
  }
  requireLocalMemory();
  const previous = queues.get(owner.key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const current = await getJSON(keys[0]);
    if (mode === "save" && current?.schema === REMOVED) throw removed();
    if (mode === "remove" && current?.schema !== "diligence.brief.v1") return false;
    const index = await getJSON(keys[1]);
    const next = [ ...(mode === "save" ? [id] : []), ...(Array.isArray(index) ? index : []).filter((x) => x !== id) ].slice(0, maximum);
    await setJSON(keys[0], value, ttl || undefined);
    await setJSON(keys[1], next, ttl || undefined);
    return true;
  });
  queues.set(owner.key, pending);
  try { return await pending; } finally { if (queues.get(owner.key) === pending) queues.delete(owner.key); }
}

export async function saveStoredBrief(owner, brief, maximum) {
  await change(owner, brief.id, brief, "save", maximum);
  return brief;
}

export async function removeStoredBrief(owner, id, maximum) {
  // Retain only a content-free marker so an already running request cannot
  // recreate a removed brief. It follows the same guest expiry as the record.
  return change(owner, id, { schema: REMOVED }, "remove", maximum);
}
