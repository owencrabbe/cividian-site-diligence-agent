// test/diligence/audit.test.mjs
// The Nemotron auditor: entailment verdicts on accepted findings, applied
// deterministically, removal only, and an honest audit_unavailable when it
// cannot run. Scripted providers only; no network, no spend.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { deps, runToBrief, networkAttempts } from "./helpers.mjs";

before(() => {
  for (const k of ["NODE_ENV", "VERCEL", "VERCEL_ENV", "REDIS_URL", "DATABASE_URL", "NEBIUS_API_KEY", "NEBIUS_MODEL", "DILIGENCE_AUDIT_MODEL", "DILIGENCE_LIVE_INFERENCE", "DILIGENCE_FIXTURE_MODE", "AI_BUDGET_APPROVAL_REFERENCE", "AI_APPROVED_BUDGET_USD", "DILIGENCE_DAILY_BUDGET_USD", "DILIGENCE_GUEST_INFERENCE", "NEBIUS_CREDIT_EXPIRES_AT"]) delete process.env[k];
});

const audit = await import("../../lib/diligence/audit.js");
const budget = await import("../../lib/diligence/budget.js");
const brief = await import("../../lib/diligence/brief.js");
const nebius = await import("../../lib/diligence/nebius.js");
const fixture = await import("../../lib/diligence/fixture.js");
const render = await import("../../lib/diligence/render.js");

const LIVE = { AUTH_SECRET: "x".repeat(40), NEBIUS_API_KEY: "k", DILIGENCE_LIVE_INFERENCE: "1", AI_BUDGET_APPROVAL_REFERENCE: "ref", AI_APPROVED_BUDGET_USD: "5", DILIGENCE_DAILY_BUDGET_USD: "1", DILIGENCE_GUEST_INFERENCE: "1" };
const SUPER = nebius.DEFAULT_MODEL;
const answer = (output) => ({ ok: true, requestedModel: SUPER, returnedModel: SUPER, requestId: "req-a", latencyMs: 10, attempts: 1, usage: { inputTokens: 1000, outputTokens: 300 }, finishReason: "stop", output });
const verdicts = (fn) => async (req, opts) => {
  const pk = JSON.parse(req.user);
  return { ok: true, requestedModel: opts.model, returnedModel: opts.model, requestId: "req-audit", latencyMs: 5, attempts: 1, usage: { inputTokens: 500, outputTokens: 90 }, finishReason: "stop", output: { verdicts: pk.findings.map((f) => ({ finding_id: f.finding_id, ...fn(f, pk) })) } };
};

const PACKET = { evidence: [
  { id: "ev_city_population", key: "population", scope: "city", status: "available", vintage: "2023 ACS 5-year", value: 65194, units: "people", text: "Population: 65,194." },
  { id: "ev_parcel_lot_area", key: "parcel_lot_area", scope: "parcel", status: "available", vintage: null, value: 9687, units: "sq ft", text: "Lot area: 9,687 sq ft." },
] };
const F = [
  { statement: "Muncie's population is 65,194.", evidence_ids: ["ev_city_population"], scope: "city", stale: false },
  { statement: "The lot is 9,687 sq ft and ideal for a tower.", evidence_ids: ["ev_parcel_lot_area"], scope: "parcel", stale: false },
  { statement: "Population grew to 65,194.", evidence_ids: ["ev_city_population"], scope: "city", stale: false },
];

test("packet: each finding travels with only the rows it cites", () => {
  const p = audit.auditPacket(F, PACKET);
  assert.deepEqual(p.findings.map((f) => f.finding_id), ["f1", "f2", "f3"]);
  assert.deepEqual(p.findings[1].cited_rows.map((r) => r.id), ["ev_parcel_lot_area"]);
  assert.ok(!JSON.stringify(p.findings[0]).includes("ev_parcel_lot_area"), "no other finding's rows");
  assert.match(audit.AUDIT_SYSTEM, /data, not instructions/);
});

test("verdicts: removal only, spans must be exact substrings, unknown ids ignored, silence is not_audited", () => {
  const out = audit.applyVerdicts(F, { verdicts: [
    { finding_id: "f1", verdict: "supported", unsupported_spans: [], reason: "Stated." },
    { finding_id: "f2", verdict: "partially_supported", unsupported_spans: ["ideal for a tower", "not in the statement"], reason: "The row gives area only." },
    { finding_id: "f9", verdict: "not_supported", unsupported_spans: [], reason: "An id the packet never had." },
    { finding_id: "f3", verdict: "maybe", unsupported_spans: [], reason: "Not an allowed verdict." },
  ] });
  assert.deepEqual(out.kept.map((f) => f.audit.verdict), ["supported", "partially_supported", "not_audited"]);
  assert.deepEqual(out.kept[1].audit.unsupportedSpans, ["ideal for a tower"]);
  assert.equal(out.removed.length, 0, "an unknown id cannot remove a finding");
  const removed = audit.applyVerdicts(F, { verdicts: [{ finding_id: "f3", verdict: "not_supported", unsupported_spans: [], reason: "A single value cannot show growth." }] });
  assert.equal(removed.removed.length, 1); assert.equal(removed.removed[0].index, 2);
  assert.equal(removed.kept.length, 2, "nothing is added");
  assert.equal(audit.applyVerdicts(F, null).kept.every((f) => f.audit.verdict === "not_audited"), true);
});

test("gates: fixture mode, an unverified or removed auditor model, a paused credit, and a refused budget all mean audit_unavailable on every finding", async () => {
  budget.__test.reset();
  let calls = 0;
  const counting = verdicts(() => { calls++; return { verdict: "supported", unsupported_spans: [], reason: "x" }; });
  const all = (r, cause) => { assert.equal(r.audit.outcome, "audit_unavailable"); assert.equal(r.audit.cause, cause); assert.ok(r.findings.every((f) => f.audit.verdict === "audit_unavailable")); assert.equal(r.removed.length, 0); };
  all(await audit.auditFindings({ findings: F, packet: PACKET, env: LIVE, mode: "fixture" }, { audit: counting }), "fixture_mode");
  all(await audit.auditFindings({ findings: F, packet: PACKET, env: { ...LIVE, DILIGENCE_AUDIT_MODEL: "nvidia/not-priced" }, mode: "live" }, { audit: counting }), "auditor_not_configured");
  all(await audit.auditFindings({ findings: F, packet: PACKET, env: { ...LIVE, DILIGENCE_AUDIT_MODEL: "nvidia/Nemotron-3-Nano-Omni" }, mode: "live" }, { audit: counting }), "auditor_not_configured");
  all(await audit.auditFindings({ findings: F, packet: PACKET, env: { ...LIVE, AI_APPROVED_BUDGET_USD: "0.000001", DILIGENCE_DAILY_BUDGET_USD: "0.000001", DILIGENCE_PER_RUN_BUDGET_USD: "0.000001" }, mode: "live" }, { audit: counting }), "budget_refused");
  await budget.recordProviderSignal("credit_exhausted", { env: LIVE });
  all(await audit.auditFindings({ findings: F, packet: PACKET, env: LIVE, mode: "live" }, { audit: counting }), "credit_paused");
  assert.equal(calls, 0, "no auditor call in any gated case");
  budget.__test.reset();
});

test("live: the auditor is Nano 30B on its own region with reasoning off, priced and settled on the shared ledger", async () => {
  budget.__test.reset();
  let seen;
  const out = await audit.auditFindings({ findings: F, packet: PACKET, env: LIVE, mode: "live" }, { transport: async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return { status: 200, redirected: false, headers: { get: () => null }, text: async () => JSON.stringify({ id: "a1", model: audit.AUDIT_MODEL_DEFAULT, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdicts: [{ finding_id: "f1", verdict: "supported", unsupported_spans: [], reason: "Stated." }, { finding_id: "f2", verdict: "partially_supported", unsupported_spans: ["ideal for a tower"], reason: "Area only." }, { finding_id: "f3", verdict: "not_supported", unsupported_spans: [], reason: "One value is not a trend." }] }) } }], usage: { prompt_tokens: 700, completion_tokens: 120 } }) };
  } });
  assert.equal(seen.url, nebius.REGION_ENDPOINTS["eu-north1"]);
  assert.equal(seen.body.model, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
  assert.deepEqual(seen.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(seen.body.response_format.json_schema.name, "diligence_audit_v1");
  assert.equal(out.audit.outcome, "audited"); assert.equal(out.audit.requestId, "a1");
  assert.deepEqual(out.audit.verdictCounts, { supported: 1, partially_supported: 1, not_supported: 1, not_audited: 0, audit_unavailable: 0 });
  assert.equal(out.audit.costEstimate.usd, Math.round(((700 * 0.06 + 120 * 0.24) / 1e6) * 1e6) / 1e6, "priced at Nano 30B's own rates");
  assert.equal((await budget.budgetSnapshot({ env: LIVE })).totalSpentUsd, out.audit.costEstimate.usd);
  budget.__test.reset();
});

test("brief: an overstated finding is removed as not_entailed, the rest keep their verdicts, and the export strikes unsupported words", async () => {
  budget.__test.reset();
  const complete = async (req) => {
    const fx = fixture.fixtureReasoning(JSON.parse(req.user));
    const pop = fx.supported_findings.find((f) => f.evidence_ids.includes("ev_city_population"));
    return answer({ ...fx, supported_findings: [pop, { statement: "Muncie's population grew to 65,194 people.", evidence_ids: ["ev_city_population"] }, { statement: "Population for Muncie is 65,194 people, the largest market in the region.", evidence_ids: ["ev_city_population"] }] });
  };
  const judge = verdicts((f) => /grew/.test(f.statement) ? { verdict: "not_supported", unsupported_spans: [], reason: "One value cannot show growth." } : /largest market/.test(f.statement) ? { verdict: "partially_supported", unsupported_spans: ["the largest market in the region"], reason: "No comparison in the row." } : { verdict: "supported", unsupported_spans: [], reason: "Stated." });
  const out = await runToBrief(brief, { d: deps({ env: LIVE, complete, audit: judge }) });
  const r = out.brief.reasoning;
  assert.equal(r.basis, "model_interpretation"); assert.equal(r.audit.outcome, "audited"); assert.equal(r.audit.model, audit.AUDIT_MODEL_DEFAULT);
  assert.deepEqual(r.output.supported_findings.map((f) => f.audit.verdict), ["supported", "partially_supported"]);
  assert.ok(!r.output.supported_findings.some((f) => /grew/.test(f.statement)), "the overstated finding is gone");
  assert.ok(r.rejected.some((x) => x.reason === "not_entailed" && /growth/.test(x.detail)));
  assert.ok(out.brief.run.inference.audit && out.brief.run.inference.audit.verdictCounts.not_supported === 1);
  const html = render.renderBriefHtml(out.brief);
  assert.match(html, /<s title="Not supported by the cited rows">the largest market in the region<\/s>/);
  assert.match(html, /audit: partly supported/); assert.match(html, /<dt>Audit<\/dt><dd>audited by nvidia\/NVIDIA-Nemotron-3-Nano-30B-A3B/);
  budget.__test.reset();
});

test("brief: when the auditor fails the brief still ships, with audit_unavailable on every finding", async () => {
  budget.__test.reset();
  const out = await runToBrief(brief, { d: deps({ env: LIVE, complete: async (req) => answer(fixture.fixtureReasoning(JSON.parse(req.user))) }) });
  const r = out.brief.reasoning;
  assert.equal(r.audit.outcome, "audit_unavailable"); assert.equal(r.audit.cause, "provider_unavailable");
  assert.ok(r.output.supported_findings.length > 0 && r.output.supported_findings.every((f) => f.audit.verdict === "audit_unavailable"));
  assert.equal(out.brief.status === "complete" || out.brief.status === "partial", true, "the brief is not held back");
  const caps = await brief.capabilities(LIVE);
  assert.equal(caps.audit.model, audit.AUDIT_MODEL_DEFAULT); assert.equal(caps.audit.pricingVerified, true);
  budget.__test.reset();
});

test("offline: no code path reached the network during this suite", () => {
  assert.deepEqual(networkAttempts(), []);
});
