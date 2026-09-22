// scripts/diligence-uptime.mjs
// Free uptime probe for the Site Diligence Agent during judging. Two GETs per
// host, no inference, no session, no cookies: /healthz for liveness and
// /api/diligence?action=status for readiness, live-AI mode, and the shared
// ledger. Writes a metadata-only receipt (status codes, latency, mode, pause
// reason, ledger dollars and dates). Response bodies are never stored.
//
// Run by hand, about weekly, from the repository root:
//   node scripts/diligence-uptime.mjs
//   node scripts/diligence-uptime.mjs --out=docs/hackathon/receipts/uptime-YYYYMMDD.json
//   node scripts/diligence-uptime.mjs --host=https://example.vercel.app
// Exit 0 when every host answers both probes, 1 otherwise. A paused live AI is
// reported, not failed: the deterministic brief still works while it is paused.
// This script is never scheduled; see docs/hackathon/DEPLOYMENT_JUDGING.md.

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOSTS = ["https://www.cividian.com", "https://cividian-site-diligence-agent.vercel.app"];
const TIMEOUT_MS = 15000;

function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function str(v, max = 120) { return typeof v === "string" ? v.slice(0, max) : null; }

async function probe(url, fetchImpl) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - t0;
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { url, status: res.status, latencyMs, json: body !== null, body };
  } catch (e) {
    return { url, status: null, latencyMs: Date.now() - t0, json: false, body: null, error: e && e.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

// Only named metadata fields leave the response. Anything else is dropped.
function statusSummary(body) {
  const inf = body && body.inference ? body.inference : {};
  const led = inf.ledger || {};
  const bud = inf.budget || {};
  const cr = inf.credit || {};
  return {
    agentVersion: str(body && body.agentVersion, 40),
    mode: str(inf.mode, 20),
    model: str(inf.model),
    keyPresent: typeof inf.keyPresent === "boolean" ? inf.keyPresent : typeof inf.configured === "boolean" ? inf.configured : null,
    paused: inf.paused && typeof inf.paused === "object" ? str(inf.paused.reason, 40) : null,
    reasons: Array.isArray(inf.reasons) ? inf.reasons.slice(0, 12).map((r) => str(r, 160)) : [],
    ledger: {
      store: str(led.store || bud.store, 20),
      approvedUsd: num(led.approvedUsd ?? bud.approvedUsd),
      spentUsd: num(led.spentUsd ?? bud.totalSpentUsd),
      remainingUsd: num(led.remainingUsd ?? bud.totalRemainingUsd),
      approvalExpiresAt: str(led.approvalExpiresAt ?? bud.expiresAt, 40),
      dailyRemainingUsd: num(led.dailyRemainingUsd ?? bud.remainingUsd),
    },
    credit: { status: str(cr.status, 40), expiresAt: str(cr.expiresAt, 40), lastLiveOkAt: str(cr.lastLiveOkAt, 40), exhaustedAt: str(cr.exhaustedAt, 40) },
  };
}

export async function probeHosts({ hosts = DEFAULT_HOSTS, fetchImpl = fetch, now = () => new Date() } = {}) {
  const started = now().toISOString();
  const results = [];
  for (const raw of hosts) {
    const base = new URL(raw).origin;
    const health = await probe(base + "/healthz", fetchImpl);
    const status = await probe(base + "/api/diligence?action=status", fetchImpl);
    const up = health.status === 200 && !!(health.body && health.body.ok === true) && status.status === 200 && !!(status.body && status.body.ok === true);
    const s = status.body ? statusSummary(status.body) : null;
    results.push({
      host: base,
      up,
      health: { status: health.status, latencyMs: health.latencyMs, ok: !!(health.body && health.body.ok === true), error: health.error || null },
      status: { status: status.status, latencyMs: status.latencyMs, ok: !!(status.body && status.body.ok === true), error: status.error || null },
      liveAi: s ? (s.mode === "live" && !s.paused ? "live" : s.mode === "live" ? "paused" : s.mode) : null,
      summary: s,
    });
  }
  return {
    schema: "diligence.uptime.v1",
    startedAt: started,
    finishedAt: now().toISOString(),
    inference: "none",
    note: "Two free GETs per host. No session, cookie, or model call. Response bodies are not stored; only the fields above.",
    ok: results.every((r) => r.up),
    hosts: results,
  };
}

function stamp(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const hosts = args.filter((a) => a.startsWith("--host=")).map((a) => a.slice(7));
  const outArg = args.find((a) => a.startsWith("--out="));
  const receipt = await probeHosts({ hosts: hosts.length ? hosts : DEFAULT_HOSTS });
  const out = outArg ? outArg.slice(6) : path.join("build", "uptime", "diligence-uptime-" + stamp(new Date(receipt.startedAt)) + ".json");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(receipt, null, 2) + "\n");
  for (const h of receipt.hosts) {
    const l = h.summary && h.summary.ledger;
    console.log((h.up ? "UP   " : "DOWN ") + h.host + "  healthz " + h.health.status + " (" + h.health.latencyMs + " ms)  status " + h.status.status + " (" + h.status.latencyMs + " ms)  live AI: " + (h.liveAi || "unknown") + (h.summary && h.summary.paused ? " (" + h.summary.paused + ")" : "") + (l && l.remainingUsd != null ? "  ledger left $" + l.remainingUsd.toFixed(4) + " of $" + l.approvedUsd : ""));
  }
  console.log("receipt: " + out);
  process.exit(receipt.ok ? 0 : 1);
}
