// End-to-end acceptance against an explicitly selected server. No secrets,
// cookies, request headers, or provider bodies are written to receipts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function demoTarget(raw, fixture = false) {
  const url = new URL(raw || "http://localhost:3411");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "BASE must be an origin without credentials, query, or path");
  assert.ok(url.protocol === "https:" || (local && url.protocol === "http:"), "HTTPS required outside localhost");
  assert.ok(!fixture || local, "Fixture verification is local only");
  return { base: url.origin, local };
}

export function inferenceReceipt(brief) {
  const inference = brief.run?.inference || {};
  const model = inference.model || brief.reasoning?.model || {};
  return { briefId: brief.id, version: brief.version, mode: inference.mode, outcome: inference.outcome,
    provider: model.provider, requestedModel: model.requestedModel, returnedModel: model.returnedModel,
    requestId: model.requestId, latencyMs: model.latencyMs, usage: model.usage,
    providerError: inference.providerError || null, finishReason: model.finishReason || null, attempts: model.attempts ?? null,
    costEstimate: model.costEstimate, validator: brief.reasoning?.validated === true ? "PASS" : "FAIL",
    accepted: inference.accepted ?? null,
    rejected: (inference.rejected || brief.reasoning?.rejected || []).map(({ path, reason }) => ({ path, reason })),
  };
}

// The zoning stage answers honestly either way: a read with verbatim, hashed,
// unverified rows, or a named reason (no_key, no_official_sources, ...).
export function zoningReceipt(brief) {
  const z = brief.zoning || null;
  const rows = (brief.evidence || []).filter((r) => /^zoning_(district_candidate|permitted_use|conditional_use|standard_)/.test(r.key));
  return z ? { status: z.status, reason: z.reason || null, jurisdiction: z.jurisdiction ? z.jurisdiction.label : null, kept: z.kept, rejected: (z.rejected || []).map((x) => x.reason), documents: (z.documents || []).map((d) => ({ host: d.host, type: d.type, skipped: d.skipped || null, textSha256: d.textSha256 || null })), reader: z.reader ? { model: z.reader.model, outcome: z.reader.outcome, requestId: z.reader.requestId, usage: z.reader.usage } : null, tavilyCalls: z.tavily ? z.tavily.calls : null, rows: rows.length } : null;
}

export function assertZoning(brief, expectRead) {
  assert.ok(brief.zoning, "The zoning stage must record its outcome");
  if (brief.zoning.status !== "read") { assert.ok(!expectRead, "Zoning was expected to read an ordinance: " + brief.zoning.reason); assert.ok(brief.zoning.reason, "An unread ordinance names its reason"); return; }
  const rows = brief.evidence.filter((r) => /^zoning_(district_candidate|permitted_use|conditional_use|standard_)/.test(r.key));
  assert.ok(rows.length > 0, "A read produces rows");
  for (const r of rows) {
    assert.equal(r.status, "unverified"); assert.equal(r.extraction, "model_output");
    assert.match(r.hash || "", /^[0-9a-f]{64}$/); assert.ok(r.excerpt && r.source && /^https:\/\//.test(r.source.url || ""));
  }
}

// Every finding carries an audit verdict; audited only when expected.
export function assertAudit(brief, expectAudited) {
  const a = brief.reasoning && brief.reasoning.audit;
  assert.ok(a, "The reasoning must record the audit");
  assert.ok(brief.reasoning.output.supported_findings.every((f) => f.audit && f.audit.verdict), "No finding ships silently unaudited");
  if (expectAudited) { assert.equal(a.outcome, "audited", "The auditor was expected to run: " + (a.cause || a.outcome)); assert.match(a.model, /^nvidia\//); assert.ok(a.requestId); }
}

export function assertInference(brief, mode) {
  assert.equal(brief.run?.inference?.mode, mode, "Actual run must use the requested mode");
  assert.equal(brief.run?.inference?.outcome, "validated", "Rejected or unavailable reasoning is not a passing demo");
  assert.equal(brief.reasoning?.validated, true);
  if (mode === "live") {
    const model = brief.reasoning.model;
    assert.equal(model.provider, "nebius");
    assert.equal(model.returnedModel, model.requestedModel);
    assert.match(model.returnedModel, /^nvidia\//);
    assert.ok(model.requestId);
    assert.ok(Number.isFinite(model.usage?.inputTokens) && Number.isFinite(model.usage?.outputTokens));
  }
}

async function main() {
  const fixture = process.argv.includes("--fixture");
  const expectZoning = process.argv.includes("--expect-zoning");
  assert.ok(fixture !== process.argv.includes("--live"), "Choose exactly one: --fixture or --live");
  const { base, local } = demoTarget(process.env.BASE, fixture);
  if (!fixture) assert.ok(process.env.AI_BUDGET_APPROVAL_REFERENCE && Number(process.env.AI_APPROVED_BUDGET_USD) > 0, "Live checks require a written approval reference and USD ceiling");
  const mode = fixture ? "fixture" : "live";
  const directory = path.resolve("build/judging", new Date().toISOString().replace(/[:.]/g, "-"));
  const receipt = { at: new Date().toISOString(), base, scope: local ? "local" : "hosted", mode, ok: false, checks: [] };
  await mkdir(directory, { recursive: true });
  let cookie = "";
  async function request(route, body, session = cookie, origin = base) {
    return fetch(base + route, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json", origin, cookie: session }, body: body ? JSON.stringify(body) : undefined });
  }
  async function json(action, body) {
    const response = await request("/api/diligence?action=" + action, body);
    assert.equal(response.status, 200, "HTTP for " + action);
    const data = await response.json();
    assert.equal(data.ok, true, "API " + action + " must succeed");
    return data;
  }
  const pass = (check) => { receipt.checks.push({ check, status: "PASS" }); console.log("PASS " + check); };
  try {
    assert.equal((await (await request("/healthz")).json()).ok, true); pass("health");
    const status = await json("status");
    assert.equal(status.inference.mode, mode);
    if (!local) assert.equal(status.inference.budget.store, "redis");
    if (!fixture) assert.equal(status.inference.guestAllowed, true);
    receipt.budgetStore = status.inference.budget.store;
    pass("capabilities and budget store");
    assert.equal(typeof status.inference.keyPresent, "boolean");
    assert.ok(status.inference.ledger && "remainingUsd" in status.inference.ledger && "approvalExpiresAt" in status.inference.ledger);
    assert.ok(status.zoning && status.audit, "Zoning and audit capabilities are reported");
    receipt.ledger = { remainingUsd: status.inference.ledger.remainingUsd, approvalExpiresAt: status.inference.ledger.approvalExpiresAt, paused: status.inference.paused ? status.inference.paused.reason : null };
    receipt.capabilities = { zoning: status.zoning.available, reader: status.zoning.readerModel, audit: status.audit.available, auditor: status.audit.model };
    pass("ledger, credit and model capabilities");
    assert.equal((await request("/api/diligence?action=list", null, "")).status, 401); pass("anonymous read refused");
    assert.equal((await request("/api/guest", {}, "", "https://cross-origin.example")).status, 403);
    assert.equal((await request("/api/diligence?action=site", { query: "Muncie, IN" }, "", "https://cross-origin.example")).status, 403); pass("cross-origin writes refused");
    const guest = await request("/api/guest", {}, "");
    assert.equal(guest.status, 200);
    cookie = (guest.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /^pago_session=/); pass("guest session");
    const site = await json("site", { query: "300 N High St, Muncie, IN" });
    assert.equal(site.site.kind, "address"); pass("Muncie site");
    const evidence = await json("evidence", { site: site.site, objective: "residential_infill", assumptions: { hardCostPerSqft: 210, rentPerSqftMonth: 1.6, capRatePct: 7 } });
    pass("evidence and scenarios");
    const zoning = await json("zoning", { id: evidence.id });
    receipt.zoning = zoningReceipt(zoning.brief);
    assertZoning(zoning.brief, expectZoning); pass("zoning stage " + zoning.brief.zoning.status + (zoning.brief.zoning.reason ? " (" + zoning.brief.zoning.reason + ")" : ""));
    const reason = await json("reason", { id: evidence.id });
    receipt.inference = inferenceReceipt(reason.brief);
    assertInference(reason.brief, mode); pass("reasoning validated");
    receipt.audit = reason.brief.reasoning.audit ? { outcome: reason.brief.reasoning.audit.outcome, cause: reason.brief.reasoning.audit.cause || null, model: reason.brief.reasoning.audit.model, counts: reason.brief.reasoning.audit.verdictCounts, requestId: reason.brief.reasoning.audit.requestId } : null;
    assertAudit(reason.brief, mode === "live" && status.audit.available); pass("findings audited or marked audit_unavailable");
    const id = reason.id;
    const exported = await request("/api/diligence?action=export&id=" + id + "&format=json");
    assert.equal(exported.status, 200);
    const saved = await exported.json();
    assert.equal(saved.id, id);
    assert.equal(saved.run.id, reason.brief.run.id);
    const html = await request("/api/diligence?action=export&id=" + id + "&format=html");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /10\. Run metadata/); pass("JSON and HTML exports");
    assert.equal((await json("get&id=" + id)).brief.id, id); pass("reopen");
    const second = await request("/api/guest", {}, "");
    const otherCookie = (second.headers.get("set-cookie") || "").split(";")[0];
    assert.match(otherCookie, /^pago_session=/);
    assert.equal((await (await request("/api/diligence?action=get&id=" + id, null, otherCookie)).json()).error, "not_found"); pass("guest isolation");
    const refreshed = await json("refresh", { id, reason: false });
    assert.equal(refreshed.brief.version, reason.brief.version + 1);
    assert.ok(refreshed.brief.changes?.counts);
    receipt.refresh = { version: refreshed.brief.version, counts: refreshed.brief.changes.counts };
    pass("refresh with change classes");
    receipt.ok = true;
  } catch (error) {
    // Only assertion labels are safe to emit. Do not emit fetch exception URLs.
    receipt.error = error.code === "ERR_ASSERTION" ? String(error.message).split("\n")[0] : "verification_request_failed";
    console.error("FAIL " + receipt.error);
  } finally {
    await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log("Receipt: " + directory + "/receipt.json");
  }
  process.exitCode = receipt.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Verification refused: check mode, BASE, and live approval variables."); process.exitCode = 1; });
}
