// Owner-run setup. Credentials live only in this process and are never echoed.
// The human explicitly approves the amount and expiry before any paid request.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { budgetPolicy, budgetSnapshot } from "../lib/diligence/budget.js";
import { nebiusStatus, DEFAULT_MODEL } from "../lib/diligence/nebius.js";
import { runSmoke } from "./nebius-smoke.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function setupStatus(env = process.env, now = new Date()) {
  const reasons = [...nebiusStatus(env).reasons, ...budgetPolicy(env, now).reasons];
  if (!env.AI_BUDGET_APPROVAL_EXPIRES_AT) reasons.push("Set the approved expiry in AI_BUDGET_APPROVAL_EXPIRES_AT");
  try {
    const url = new URL(env.REDIS_URL || "");
    if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname) throw new Error();
  } catch { reasons.push("REDIS_URL must be the isolated database TCP connection URL"); }
  return { ok: reasons.length === 0, reasons, credentials: { nebius: !!env.NEBIUS_API_KEY, redis: !!env.REDIS_URL, census: !!env.CENSUS_API_KEY }, policy: budgetPolicy(env, now) };
}

async function prompt(label, { hidden = false } = {}) {
  let muted = false;
  const sink = new Writable({ write(chunk, encoding, next) { if (!muted) process.stdout.write(chunk, encoding); next(); } });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  const abort = new AbortController();
  rl.once("SIGINT", () => abort.abort());
  try {
    const answer = rl.question(label, { signal: abort.signal });
    muted = hidden;
    return (await answer).trim();
  } finally {
    rl.close();
    if (hidden) process.stdout.write("\n");
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    const status = setupStatus();
    // Only presence, non-secret approval metadata, and static reasons.
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.ok ? 0 : 1);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive_terminal_required");
  console.log("Live Site Diligence setup. Credentials are hidden and stay in memory.");
  console.log("Use a dedicated Redis database. Reuse it for hosting so all runs share the total spending ledger.");
  console.log("Nebius key: https://tokenfactory.nebius.com/ > API keys > Get API key");
  console.log("Redis: https://cloud.redis.io/ > dedicated database > Connect > TCP URL");
  console.log("Optional Census key: https://api.census.gov/data/key_signup.html");
  if (!process.env.NEBIUS_API_KEY) process.env.NEBIUS_API_KEY = await prompt("Paste NEBIUS_API_KEY (hidden): ", { hidden: true });
  if (!process.env.REDIS_URL) process.env.REDIS_URL = await prompt("Paste isolated REDIS_URL (hidden): ", { hidden: true });
  if (!process.env.CENSUS_API_KEY) process.env.CENSUS_API_KEY = await prompt("Optional CENSUS_API_KEY, or Enter to skip (hidden): ", { hidden: true });
  process.env.AI_APPROVED_BUDGET_USD = await prompt("Total inference ceiling in USD (example 5, no default): ");
  process.env.AI_BUDGET_APPROVAL_EXPIRES_AT = await prompt("Approval expiry with timezone (example 2026-12-16T08:00:00Z): ");
  process.env.AI_BUDGET_APPROVAL_REFERENCE = "owner-terminal-" + new Date().toISOString();
  process.env.NEBIUS_MODEL ||= DEFAULT_MODEL;
  const approved = Number(process.env.AI_APPROVED_BUDGET_USD);
  process.env.DILIGENCE_DAILY_BUDGET_USD = String(Math.min(1, approved));
  process.env.DILIGENCE_PER_RUN_BUDGET_USD = String(Math.min(0.25, approved));
  process.env.DILIGENCE_MAX_CONCURRENT = "3";
  const status = setupStatus();
  if (!status.ok) { console.log(JSON.stringify(status, null, 2)); throw new Error("configuration_incomplete"); }
  console.log("Model: " + process.env.NEBIUS_MODEL + ". Check its current price in https://tokenfactory.nebius.com/pricing.");
  console.log("The app caps list-price estimates; the provider console remains the billing source of truth.");
  const approval = await prompt("Type APPROVE to allow up to $" + approved + " total estimated inference through " + status.policy.expiresAt + " ($" + status.policy.dailyUsd + "/day, $" + status.policy.perRunUsd + "/run), including one smoke request now: ");
  if (approval !== "APPROVE") throw new Error("approval_not_given");
  // This owner command only starts a loopback server. Never inherit a host or
  // fixture switch that could expose it or allow a rehearsal to look live.
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "3412";
  process.env.SITE_URL = "http://localhost:3412";
  process.env.AUTH_SECRET = randomBytes(32).toString("hex");
  process.env.DILIGENCE_FIXTURE_MODE = "0";
  process.env.DILIGENCE_LIVE_INFERENCE = "1";
  process.env.DILIGENCE_GUEST_INFERENCE = "1";
  const snapshot = await budgetSnapshot();
  if (snapshot.unavailable || snapshot.store !== "redis") throw new Error("isolated_redis_unavailable");
  const dir = path.join(ROOT, "build", "live-setup", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  const authorization = { at: new Date().toISOString(), method: "owner typed APPROVE in private terminal", ...status.policy };
  await writeFile(path.join(dir, "approval.json"), JSON.stringify(authorization, null, 2) + "\n");
  const smoke = await runSmoke();
  await writeFile(path.join(dir, "smoke.json"), JSON.stringify(smoke, null, 2) + "\n");
  console.log("Metadata-only receipts: " + path.relative(ROOT, dir));
  if (!smoke.ok) { console.log("Smoke failed: " + smoke.error + ". No automatic retry."); throw new Error("smoke_failed"); }
  const { start } = await import("../lib/diligence/standalone-server.mjs");
  await start();
  console.log("Live server ready at http://localhost:3412/diligence. Keep this terminal open and tell Codex it is ready.");
  console.log("Ctrl+C stops the server. Credentials have not been written to any file.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Transport or configuration exceptions may contain a secret. Static text only.
    const safe = new Set(["interactive_terminal_required", "configuration_incomplete", "approval_not_given", "isolated_redis_unavailable", "smoke_failed"]);
    console.error("Live setup stopped: " + (safe.has(error?.message) ? error.message : "setup_failed") + ". Check the requirements above and rerun in your own terminal. No exception details were logged.");
    process.exit(1);
  });
}
