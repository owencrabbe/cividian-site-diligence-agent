// Starts its own disposable, loopback-only Redis process. Never uses REDIS_URL.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createClient } from "redis";
import { reserveRun, settleRun, budgetSnapshot, recordProviderSignal } from "../../lib/diligence/budget.js";
import { getBudgetRedis } from "../../lib/diligence/budget-connection.js";
import { DEFAULT_MODEL } from "../../lib/diligence/nebius.js";

test("Redis Lua: parallel reservations, caps, settlement, TTL, and outage refusal", { timeout: 20000 }, async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--protected-mode", "yes"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  const url = "redis://127.0.0.1:" + port;
  const db = createClient({ url, socket: { reconnectStrategy: false } });
  db.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated Redis did not start")), 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Isolated Redis exited before ready")); });
      child.stdout.on("data", (data) => { if (String(data).includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
    });
    await db.connect();
    const env = { NODE_ENV: "production", REDIS_URL: url, AI_BUDGET_APPROVAL_REFERENCE: "synthetic-test-no-inference", AI_APPROVED_BUDGET_USD: "1", DILIGENCE_DAILY_BUDGET_USD: "0.1", DILIGENCE_PER_RUN_BUDGET_USD: "0.05", DILIGENCE_MAX_CONCURRENT: "2" };
    const connect = async () => db;
    const now = new Date("2026-09-20T12:00:00Z");
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.04, env, connect, now })));
    const accepted = outcomes.filter((out) => out.ok);
    assert.equal(accepted.length, 2, "Lua atomically admits exactly two concurrent calls");
    assert.ok(outcomes.filter((out) => !out.ok).every((out) => out.error === "concurrency_limit"));
    assert.equal((await budgetSnapshot({ env, connect, now })).reservedUsd, 0.08);
    assert.ok(await db.ttl("pago:diligence:budget:2026-09-20") > 0);
    assert.ok(await db.ttl("pago:diligence:inflight") > 0);
    await settleRun(accepted[0].reservationId, 0.02, { env, connect });
    await settleRun(accepted[1].reservationId, undefined, { env, connect });
    const settled = await budgetSnapshot({ env, connect, now });
    assert.equal(settled.spentUsd, 0.06, "Missing usage settles at reserved cost");
    assert.equal(settled.reservedUsd, 0);
    assert.equal(settled.inflight, 0);
    assert.equal(settled.runs, 2);
    assert.equal((await reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.05, env, connect, now })).error, "daily_budget_exhausted");
    assert.equal((await reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.06, env, connect, now })).error, "per_run_cap_exceeded");
    assert.equal((await reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.01, env, now, connect: async () => null })).error, "budget_store_unavailable");
    assert.equal((await reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.01, env: { ...env, REDIS_URL: undefined }, now })).error, "budget_store_unavailable");
    assert.equal(await settleRun(accepted[0].reservationId, 0.02, { env, connect }), false, "Settlement cannot count a call twice");
    assert.equal(await db.ttl("pago:diligence:budget:total"), -1, "Total approval ledger does not expire");
    // Leave only $0.09 of the total approval, but $0.10 on the next UTC day.
    // Concurrent requests must check both ledgers in the same Lua operation.
    const nextEnv = { ...env, AI_APPROVED_BUDGET_USD: "0.15", AI_BUDGET_APPROVAL_REFERENCE: "edited-note", DILIGENCE_MAX_CONCURRENT: "20" };
    const nextDay = new Date("2026-09-21T00:01:00Z");
    const next = await Promise.all(Array.from({ length: 12 }, () => reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.03, env: nextEnv, connect, now: nextDay })));
    assert.equal(next.filter((out) => out.ok).length, 3);
    assert.equal((await budgetSnapshot({ env: nextEnv, connect, now: nextDay })).totalRemainingUsd, 0);
    await Promise.all(next.filter((out) => out.ok).map((out) => settleRun(out.reservationId, null, { env: nextEnv, connect })));
    const later = new Date("2026-09-22T00:01:00Z");
    assert.equal((await reserveRun({ model: DEFAULT_MODEL, estimateUsd: 0.01, env: nextEnv, connect, now: later })).error, "approved_budget_exhausted");
    const end = await budgetSnapshot({ env: nextEnv, connect, now: later });
    assert.equal(end.spentUsd, 0, "Daily counter starts empty");
    assert.equal(end.totalSpentUsd, 0.15, "Total spending remains after UTC rollover");
    assert.equal(end.creditExhaustedAt, null); assert.equal(end.lastLiveOkAt, null);
    assert.equal(await recordProviderSignal("credit_exhausted", { env: nextEnv, connect, now: later }), true);
    assert.equal(await recordProviderSignal("not_a_signal", { env: nextEnv, connect, now: later }), false);
    const signalled = await budgetSnapshot({ env: nextEnv, connect, now: later });
    assert.equal(signalled.creditExhaustedAt, later.toISOString(), "A credit refusal is recorded on the shared ledger");
    assert.equal(signalled.totalSpentUsd, 0.15, "Recording a signal never changes spend");
    assert.equal(await db.ttl("pago:diligence:budget:total"), -1, "The signal does not add an expiry to the ledger");
    const originalBudgetUrl = process.env.DILIGENCE_BUDGET_REDIS_URL;
    const originalAccountUrl = process.env.REDIS_URL;
    let shared;
    try {
      process.env.DILIGENCE_BUDGET_REDIS_URL = url;
      process.env.REDIS_URL = 'redis://127.0.0.1:1';
      shared = await getBudgetRedis();
      assert.ok(shared, 'Shared budget store connects independently of account storage');
      const sharedSnapshot = await budgetSnapshot({ env: { ...nextEnv, REDIS_URL: undefined, DILIGENCE_BUDGET_REDIS_URL: url }, now: later });
      assert.equal(sharedSnapshot.totalSpentUsd, 0.15, 'Changing hosts cannot reset the existing ledger');
      await shared.quit();
      process.env.DILIGENCE_BUDGET_REDIS_URL = 'redis://127.0.0.1:1';
      process.env.REDIS_URL = url;
      assert.equal(await getBudgetRedis(), null, 'A shared ledger outage cannot fall back to an empty account-store ledger');
    } finally {
      if (shared?.isOpen) await shared.quit();
      if (originalBudgetUrl === undefined) delete process.env.DILIGENCE_BUDGET_REDIS_URL; else process.env.DILIGENCE_BUDGET_REDIS_URL = originalBudgetUrl;
      if (originalAccountUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = originalAccountUrl;
    }
  } finally {
    if (db.isOpen) await db.quit();
    child.kill("SIGTERM");
    await exited;
  }
});
