// test/diligence/live-eval.test.mjs
// The live evaluation harness, run against scripted providers: the claim
// metric, the upfront estimate and its refusals, phase one's spend check, and
// the report. No network, no spend.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deps, loadZoningFixtures, zoningScripted, networkAttempts } from "./helpers.mjs";

before(() => {
  for (const k of ["NODE_ENV", "VERCEL", "VERCEL_ENV", "REDIS_URL", "DATABASE_URL", "NEBIUS_API_KEY", "NEBIUS_MODEL", "TAVILY_API_KEY", "DILIGENCE_LIVE_INFERENCE", "DILIGENCE_FIXTURE_MODE", "AI_BUDGET_APPROVAL_REFERENCE", "AI_APPROVED_BUDGET_USD", "DILIGENCE_DAILY_BUDGET_USD", "DILIGENCE_GUEST_INFERENCE"]) delete process.env[k];
});

const live = await import("../../scripts/diligence-live-eval.mjs");
const budget = await import("../../lib/diligence/budget.js");
const fixture = await import("../../lib/diligence/fixture.js");
const nebius = await import("../../lib/diligence/nebius.js");

const ENV = { DILIGENCE_TAVILY_ENABLED: "1", TAVILY_BUDGET_APPROVAL_REFERENCE: "synthetic", TAVILY_APPROVED_CREDITS: "1000", TAVILY_DAILY_CREDITS: "1000", TAVILY_APPROVAL_EXPIRES_AT: "2030-01-01T00:00:00Z", AUTH_SECRET: "x".repeat(40), NEBIUS_API_KEY: "k", TAVILY_API_KEY: "t", DILIGENCE_LIVE_INFERENCE: "1", DILIGENCE_GUEST_INFERENCE: "1", AI_BUDGET_APPROVAL_REFERENCE: "eval-approval", AI_APPROVED_BUDGET_USD: "5", DILIGENCE_DAILY_BUDGET_USD: "1", DILIGENCE_PER_RUN_BUDGET_USD: "0.25" };
const SITES = [
  { id: "muncie-t1", city: "Muncie", address: "300 N High St, Muncie, IN 47305", category: "downtown_building", objective: "adaptive_reuse" },
  { id: "muncie-t2", city: "Muncie", address: "300 N High St, Muncie, IN 47305", category: "vacant_lot", objective: "residential_infill" },
  { id: "muncie-t3", city: "Muncie", address: "300 N High St, Muncie, IN 47305", category: "industrial_parcel", objective: "mixed_use" },
  { id: "muncie-t4", city: "Muncie", address: "300 N High St, Muncie, IN 47305", category: "commercial_building", objective: "mixed_use" },
];

// Super writes prose in mode A (one number from the packet, two invented) and
// labeled fixture reasoning in B and C. The auditor removes nothing here.
function scriptedDeps(overA = {}) {
  const d = deps({ env: ENV });
  const calls = { A: 0, reason: 0, audit: 0 };
  d.complete = async (req, opts) => {
    const usage = { inputTokens: 900, outputTokens: 400, ...(req.schemaName === "bare_brief" ? overA.usage : {}) };
    if (req.schemaName === "bare_brief") { calls.A++; return { ok: true, requestedModel: opts.model, returnedModel: opts.model, requestId: "bare-" + calls.A, latencyMs: 5, attempts: 1, usage, finishReason: "stop", output: { brief: "Muncie has about 65,194 residents. Median household income is roughly $52,000 and the site allows 117 feet of height. Built around 1925." } }; }
    calls.reason++;
    return { ok: true, requestedModel: nebius.DEFAULT_MODEL, returnedModel: nebius.DEFAULT_MODEL, requestId: "sup-" + calls.reason, latencyMs: 5, attempts: 1, usage, finishReason: "stop", output: fixture.fixtureReasoning(JSON.parse(req.user)) };
  };
  d.audit = async (req, opts) => { calls.audit++; const pk = JSON.parse(req.user); return { ok: true, requestedModel: opts.model, returnedModel: opts.model, requestId: "aud-" + calls.audit, latencyMs: 5, attempts: 1, usage: { inputTokens: 300, outputTokens: 60 }, finishReason: "stop", output: { verdicts: pk.findings.map((f) => ({ finding_id: f.finding_id, verdict: "supported", unsupported_spans: [], reason: "Stated." })) } }; };
  d.zoning = zoningScripted(loadZoningFixtures().find((f) => f.file === "muncie.json")).deps;
  return { d, calls };
}

test("claims: years and the address's own numbers are not claims; matches use the validator's tolerance", () => {
  const packet = { evidence: [{ id: "e1", value: 65194, text: "Population: 65,194." }], scenarios: [], assumptions: [], unknowns: [], questions: [] };
  const m = live.claimMetrics("About 65,200 people live here (2023). The lot at 300 N High St is 47305-adjacent; income is $52,000.", packet, "300 N High St, Muncie, IN 47305");
  assert.deepEqual(m, { claims: 2, matched: 1, unsupported: 1 }, "65,200 is within 2% of 65,194; $52,000 is not in the packet");
});

test("estimate: every mode has a positive upper bound and the full agent costs more than the packet alone", () => {
  const e = live.estimateSite(["A", "B", "C"]);
  assert.ok(e.A > 0 && e.B > 0 && e.C > e.B, JSON.stringify(e));
});

test("refusals: a dry run calls nothing; a live run needs the gate, the approval reference and a cap that covers the estimate", async () => {
  budget.__test.reset();
  const { d, calls } = scriptedDeps();
  const logs = [];
  const dry = await live.runLiveEval({ sites: SITES, env: ENV, dryRun: true, deps: d, log: (l) => logs.push(l) });
  assert.equal(dry.ok, true); assert.equal(dry.dryRun, true); assert.ok(dry.plan.estimateUsd > 0); assert.match(logs[0], /^Estimate \(reservation upper bound\)/);
  assert.equal((await live.runLiveEval({ sites: SITES, env: { ...ENV, NEBIUS_API_KEY: "" }, deps: d, log() {} })).error, "live_inference_not_configured");
  assert.equal((await live.runLiveEval({ sites: SITES, env: ENV, deps: d, log() {} })).error, "approval_reference_required");
  assert.equal((await live.runLiveEval({ sites: SITES, env: ENV, deps: d, approvedLive: "some-other-note", log() {} })).error, "approval_reference_required");
  assert.equal((await live.runLiveEval({ sites: SITES, env: ENV, deps: d, approvedLive: "eval-approval", maxUsd: 0.0001, log() {} })).error, "estimate_exceeds_cap");
  assert.deepEqual(calls, { A: 0, reason: 0, audit: 0 }, "no model call in any refused run");
  budget.__test.reset();
});

test("preflight refuses unknown model prices and empty plans before any request", async () => {
  budget.__test.reset();
  const { d, calls } = scriptedDeps();
  for (const overrides of [{ sites: [] }, { modes: [] }, { env: { ...ENV, DILIGENCE_READER_MODEL: "nvidia/unknown-synthetic" } }]) {
    const run = await live.runLiveEval({ sites: SITES, env: ENV, deps: d, approvedLive: "eval-approval", log() {}, ...overrides });
    assert.equal(run.error, "invalid_benchmark_plan");
  }
  assert.deepEqual(calls, { A: 0, reason: 0, audit: 0 });
});

test("phase one: if mode A on the first sites spends more than its estimate, the run stops before anything else", async () => {
  budget.__test.reset();
  const { d, calls } = scriptedDeps({ usage: { inputTokens: 200000, outputTokens: 1500 } });
  const run = await live.runLiveEval({ sites: SITES, env: ENV, deps: d, approvedLive: "eval-approval", maxUsd: 2, log() {} });
  assert.equal(run.ok, false); assert.equal(run.error, "phase_one_over_estimate");
  assert.equal(calls.A, live.PHASE_ONE_SITES); assert.equal(calls.reason, 0, "B and C never started");
  budget.__test.reset();
});

test("run: three modes on scripted providers; A's invented numbers are counted, B and C carry none, C reads zoning and is audited", async () => {
  budget.__test.reset();
  const { d, calls } = scriptedDeps();
  const run = await live.runLiveEval({ sites: SITES, env: ENV, deps: d, approvedLive: "eval-approval", maxUsd: 2, log() {}, now: () => new Date("2026-10-10T12:00:00Z") });
  assert.equal(run.ok, true, JSON.stringify(run.error));
  assert.equal(calls.A, SITES.length); assert.equal(calls.reason, SITES.length * 2); assert.equal(calls.audit, SITES.length, "only mode C is audited");
  const s = live.summarize(run.results, ["A", "B", "C"]);
  const [A, B, C] = s;
  assert.equal(A.claims, SITES.length * 3); assert.equal(A.matched, SITES.length); assert.equal(A.unsupported, SITES.length * 2);
  assert.equal(B.unsupported, 0); assert.equal(C.unsupported, 0);
  assert.equal(C.zoningRead, SITES.length); assert.equal(B.zoningRead, null);
  assert.ok(run.spentUsd > 0 && run.spentUsd <= run.plan.estimateUsd, run.spentUsd + " within " + run.plan.estimateUsd);
  const md = live.renderMarkdown(run, SITES);
  assert.match(md, /^# Site Diligence Agent live evaluation/);
  assert.match(md, /\| A\. Bare model \(Super, address only\) \| 4 \(4\) \| 12 \| 4 \| 8 \| 66\.7% \|/);
  assert.ok(!/\u2014/.test(md), "no em dashes");
  assert.ok(!md.includes("65,194 residents"), "the report carries no model text");
  budget.__test.reset();
});

test("failed canaries and an unavailable C stage never report completed live acceptance", async () => {
  budget.__test.reset();
  const bad = scriptedDeps();
  const complete = bad.d.complete;
  bad.d.complete = async (req, opts) => req.schemaName === "bare_brief" ? { ...(await complete(req, opts)), output: { brief: "" } } : complete(req, opts);
  const canary = await live.runLiveEval({ sites: SITES, env: ENV, deps: bad.d, approvedLive: "eval-approval", log() {} });
  assert.equal(canary.error, "phase_one_failed"); assert.equal(bad.calls.reason, 0);
  budget.__test.reset();
  const down = scriptedDeps();
  down.d.audit = async () => ({ ok: false, error: "provider_unavailable" });
  const degraded = await live.runLiveEval({ sites: SITES.slice(0, 1), modes: ["C"], env: ENV, deps: down.d, approvedLive: "eval-approval", log() {} });
  assert.equal(degraded.ok, false); assert.equal(degraded.error, "incomplete_modes");
  assert.equal(degraded.results[0].error, "full_agent_incomplete");
  assert.equal(degraded.results[0].audit.outcome, "audit_unavailable");
  budget.__test.reset();
});

test("sites: an address the product's geocoder misses falls back to its verified Census point, and says so", async () => {
  const d = deps({ env: ENV });
  const site = { id: "t", city: "Muncie", address: "1 Nowhere Industrial Rd, Muncie, IN", geocode: { lat: 40.19628, lon: -85.387806 } };
  const missing = { ...d.site, geocode: async () => ({ ok: false, error: "not found" }) };
  const r = await live.resolveEvalSite(site, missing);
  assert.equal(r.ok, true); assert.equal(r.input, "census_point"); assert.equal(r.addressError, "not_found");
  assert.equal(r.site.kind, "point");
  assert.equal((await live.resolveEvalSite(site, d.site)).input, "address", "an address that resolves is used as typed");
  assert.equal((await live.resolveEvalSite({ ...site, geocode: undefined }, missing)).ok, false, "no silent fallback without a verified point");
  const listed = JSON.parse(readFileSync(new URL("./live-sites.json", import.meta.url), "utf8"));
  assert.equal(listed.sites.length, 24);
  assert.ok(listed.sites.every((x) => x.source && /^https:\/\//.test(x.source.url) && x.geocode && Number.isFinite(x.geocode.lat) && ["vacant_lot", "downtown_building", "industrial_parcel", "commercial_building"].includes(x.category)));
});

test("offline: no code path reached the network during this suite", () => {
  assert.deepEqual(networkAttempts(), []);
});
