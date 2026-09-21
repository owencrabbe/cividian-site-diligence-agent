// Own disposable Redis only. No provider requests or existing database access.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { getRedis } from "../../lib/redis.js";
import { StorageUnavailableError } from "../../lib/storage-policy.js";
import { saveStoredBrief, removeStoredBrief } from "../../lib/diligence/storage.js";

test("beta Redis: atomic list, owner isolation, removal, expiry, and closed outage", { timeout: 15000 }, async () => {
  const previous = { ...process.env };
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--protected-mode", "yes"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  let client;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Disposable Redis startup timeout")), 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on("data", (data) => { if (String(data).includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
    });
    process.env.REDIS_URL = "redis://127.0.0.1:" + port;
    delete process.env.REDIS_KEY_PREFIX;
    process.env.NODE_ENV = "production";
    client = await getRedis();
    assert.ok(client);
    const owner = { key: "guest:beta-test", kind: "guest", expiresAt: new Date(Date.now() + 60000).toISOString(), ttl: 86400 };
    const records = Array.from({ length: 20 }, (_, i) => ({ schema: "diligence.brief.v1", id: "dlg_" + String(i).padStart(24, "0"), confidentialExample: "synthetic-content-to-remove" }));
    await Promise.all(records.map((record) => saveStoredBrief(owner, record, 50)));
    const indexKey = "pago:diligence:index:" + owner.key;
    assert.equal(JSON.parse(await client.get(indexKey)).length, 20);
    const recordKey = "pago:diligence:brief:" + owner.key + ":" + records[0].id;
    assert.ok(await client.ttl(recordKey) <= 60);
    assert.ok(await client.ttl(recordKey) > 0);
    assert.equal(await removeStoredBrief({ ...owner, key: "guest:another-owner" }, records[0].id, 50), false);
    assert.equal(await removeStoredBrief(owner, records[0].id, 50), true);
    assert.equal(JSON.parse(await client.get(indexKey)).length, 19);
    assert.deepEqual(JSON.parse(await client.get(recordKey)), { schema: "diligence.deleted.v1" });
    await assert.rejects(saveStoredBrief(owner, records[0], 50), { code: "brief_removed" });
    assert.ok(!(await client.get(recordKey)).includes("synthetic-content"));
    await Promise.all(records.slice(1).map((record) => removeStoredBrief(owner, record.id, 50)));
    assert.equal(Object.keys(JSON.parse(await client.get(indexKey))).length, 0);
    await saveStoredBrief(owner, { schema: "diligence.brief.v1", id: "dlg_" + "f".repeat(24) }, 50);
    assert.equal(JSON.parse(await client.get(indexKey)).length, 1, "can save again after an empty Lua index");
    await client.quit();
    child.kill("SIGTERM"); await exited;
    await assert.rejects(saveStoredBrief(owner, records[1], 50), StorageUnavailableError);
  } finally {
    if (client?.isOpen) await client.quit();
    child.kill("SIGTERM"); await exited;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
