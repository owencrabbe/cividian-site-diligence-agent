// scripts/diligence-live-eval.mjs
// Live benchmark of the Site Diligence Agent on real Indiana sites, in three
// modes per site:
//
//   A  bare model   Nemotron 3 Super gets only the address and objective and
//                   writes a diligence brief in prose.
//   B  packet       the evidence packet and the validator, no zoning read and
//                   no auditor (the entry as it stood on 2026-09-21).
//   C  full agent   B plus the zoning ordinance reader and the auditor.
//
// Metrics are deterministic. The evidence packet is gathered for every site,
// including in mode A, so A's numbers can be checked against it with the
// validator's own tolerance rule. Per brief: numeric claims made, claims that
// match a packet value, unsupported claims, items rejected by each stage,
// zoning coverage, tokens, estimated cost, latency. Years, small counts (0 to
// 12, as the validator treats them) and the address's own numbers are not
// counted as claims.
//
// Spending: every model call goes through the shared ledger's reservation.
// The full run is estimated first (reservation upper bounds) and refused if
// the estimate exceeds --max-usd or the ledger's remaining approval. Mode A
// runs on the first 3 sites; if the spend so far exceeds its estimate the run
// stops. Only then does the rest run. Owner gate G2 applies: a live run needs
// --approved-live=<AI_BUDGET_APPROVAL_REFERENCE>.
//
//   node scripts/diligence-live-eval.mjs --check-sites              # resolve every site and parcel, no model calls
//   node scripts/diligence-live-eval.mjs --dry-run                  # estimate only, no model calls
//   node scripts/diligence-live-eval.mjs --approved-live=<ref> --max-usd=0.50
//   node scripts/diligence-live-eval.mjs --approved-live=<ref> --sites=6 --modes=A,C
//
// Writes docs/hackathon/EVAL_LIVE.md and docs/hackathon/receipts/live-eval-YYYYMMDD.json
// (metadata only: no model text, no keys) after a completed live run.

import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { livePause } from "../lib/diligence/credit.js";
import { recordProviderSignal } from "../lib/diligence/budget.js";
import { tavilyPolicy, tavilySnapshot } from "../lib/diligence/tavily-budget.js";
import * as brief from "../lib/diligence/brief.js";
import { resolveSite } from "../lib/diligence/site.js";
import { buildPacket } from "../lib/diligence/packet.js";
import { numbersIn, numberAllowed, packetNumbers, REASONING_SCHEMA } from "../lib/diligence/schema.js";
import { nebiusComplete, nebiusStatus, estimateRequestCost, estimateCompletionCost, DEFAULT_MODEL } from "../lib/diligence/nebius.js";
import { reserveRun, settleRun, budgetSnapshot, liveInferenceStatus } from "../lib/diligence/budget.js";
import { READER_SYSTEM, READER_SCHEMA, ZONING_LIMITS, readerModel } from "../lib/diligence/zoning.js";
import { AUDIT_SYSTEM, AUDIT_SCHEMA, AUDIT_LIMITS, auditModel } from "../lib/diligence/audit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OWNER = { kind: "guest", key: "guest:local-eval-" + randomUUID(), ttl: 3600 };
export const PHASE_ONE_SITES = 3;

export const BARE_SCHEMA = { type: "object", additionalProperties: false, required: ["brief"], properties: { brief: { type: "string", maxLength: 4000 } } };
export const BARE_SYSTEM = "You are a commercial real estate site diligence analyst. Write a concise diligence brief for the site and objective: zoning, market, the physical site, risks and next steps. Use specific figures where you know them. Output only JSON: {\"brief\": \"...\"}.";

// The product's address geocoder (OpenStreetMap) misses some addresses the
// Census Geocoder matches. The evaluation then uses the verified point, as a
// user would by clicking the map; each result records which input was used.
export async function resolveEvalSite(site, siteDeps = {}) {
  const byAddress = await resolveSite({ query: site.address }, siteDeps);
  if (byAddress.ok || !site.geocode) return { ...byAddress, input: "address" };
  const byPoint = await resolveSite({ lat: site.geocode.lat, lon: site.geocode.lon, city: site.city, state: "IN" }, siteDeps);
  return { ...byPoint, input: "census_point", addressError: byAddress.error };
}

export function bareRequest(site) {
  return { system: BARE_SYSTEM, user: JSON.stringify({ address: site.address, city: site.city, state: "IN", objective: site.objective }), schemaName: "bare_brief", schema: BARE_SCHEMA, maxTokens: 1500, temperature: 0.2 };
}

// Numeric claims: every number token, less years, the address's own numbers
// and the small counts (integers 0 to 12) the validator also exempts. Matched:
// within the validator's tolerance of any packet number.
export function claimMetrics(text, packet, address) {
  const own = new Set(numbersIn(address));
  const claims = numbersIn(text).filter((n) => !(Number.isInteger(n) && ((n >= 1900 && n <= 2100) || (n >= 0 && n <= 12))) && !own.has(n));
  const allowed = packetNumbers(packet);
  const matched = claims.filter((n) => numberAllowed(n, allowed));
  return { claims: claims.length, matched: matched.length, unsupported: claims.length - matched.length };
}

function outputText(o) {
  if (!o) return "";
  return [o.executive_assessment, ...o.supported_findings.map((f) => f.statement), ...o.scenario_comparison.map((s) => s.rationale), ...o.decisive_unknowns.map((u) => u.statement + " " + u.why), ...o.conflicts.map((c) => c.statement), ...o.investigation_plan.map((p) => p.verification_method + " " + p.rationale), ...o.assumption_sensitivity.map((a) => a.effect), ...o.limitations].filter(Boolean).join("\n");
}

// Upper-bound reservations per mode, before any call.
export function estimateSite(modes, env = {}) {
  const est = {};
  const worstPacket = "x".repeat(brief.LIMITS.packetMaxBytes);
  const superUsd = estimateRequestCost(DEFAULT_MODEL, { system: "x".repeat(4000), user: worstPacket, schemaName: "diligence_reasoning_v1", schema: REASONING_SCHEMA, maxTokens: brief.LIMITS.maxOutputTokens }).usd;
  const readerUsd = estimateRequestCost(readerModel(env), { system: READER_SYSTEM, user: "x".repeat(ZONING_LIMITS.packetMaxChars * 3 + 8000), schemaName: "zoning_read_v1", schema: READER_SCHEMA, maxTokens: ZONING_LIMITS.readerMaxTokens }).usd;
  const auditUsd = estimateRequestCost(auditModel(env), { system: AUDIT_SYSTEM, user: "x".repeat(30000), schemaName: "diligence_audit_v1", schema: AUDIT_SCHEMA, maxTokens: AUDIT_LIMITS.maxTokens }).usd;
  if (modes.includes("A")) est.A = estimateRequestCost(DEFAULT_MODEL, bareRequest({ address: "x".repeat(80), city: "x".repeat(20), objective: "mixed_use" })).usd;
  if (modes.includes("B")) est.B = superUsd;
  if (modes.includes("C")) est.C = [superUsd, readerUsd, auditUsd].every((v) => Number.isFinite(v) && v > 0) ? superUsd + readerUsd + auditUsd : null;
  return est;
}

async function runBare(site, packet, { env, complete, connect }) {
  const t0 = Date.now();
  const req = bareRequest(site);
  const est = estimateRequestCost(DEFAULT_MODEL, req);
  const pause = livePause({ env, budget: await budgetSnapshot({ env, connect }), model: DEFAULT_MODEL, maxOutputTokens: req.maxTokens });
  if (pause) return { mode: "A", ok: false, error: pause.reason };
  const reservation = await reserveRun({ model: DEFAULT_MODEL, estimateUsd: est.usd, env, connect });
  if (!reservation.ok) return { mode: "A", ok: false, error: reservation.error };
  let r;
  try { r = await (complete || nebiusComplete)(req, { env, model: DEFAULT_MODEL }); }
  catch { r = { ok: false, error: "provider_unavailable" }; }
  const cost = estimateCompletionCost(DEFAULT_MODEL, r, est);
  const usd = cost.usd == null ? est.usd : cost.usd;
  await settleRun(reservation.reservationId, usd, { env, connect });
  if (r.error === "provider_credit_exhausted") await recordProviderSignal("credit_exhausted", { env, connect });
  else if (r.ok) await recordProviderSignal("ok", { env, connect });
  if (r.ok && (r.returnedModel !== DEFAULT_MODEL || !r.requestId || !Number.isFinite(r.usage?.inputTokens) || !Number.isFinite(r.usage?.outputTokens))) r = { ...r, ok: false, error: "receipt_metadata_missing" };
  if (r.ok && (typeof r.output?.brief !== "string" || !r.output.brief.trim() || r.output.brief.length > 4000)) r = { ...r, ok: false, error: "bare_output_rejected" };
  const text = r.ok ? r.output.brief : "";
  return { mode: "A", ok: r.ok, error: r.ok ? null : r.error, ...claimMetrics(text, packet, site.address), rejected: { validator: null, auditor: null, zoning: null }, zoning: null, tokens: r.usage ? (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0) : null, usd, latencyMs: Date.now() - t0, requestIds: [r.requestId || null] };
}

async function runAgent(mode, site, d, env) {
  const t0 = Date.now();
  const resolved = await resolveEvalSite(site, d.site || {});
  if (!resolved.ok) return { mode, ok: false, error: "site_" + resolved.error };
  const started = await brief.startRun({ site: resolved.site, objective: site.objective, assumptions: {} }, OWNER, { ...d, env });
  if (!started.ok) return { mode, ok: false, error: started.error };
  try {
  let zoning = null, zoningRejected = null;
  if (mode === "C") {
    const z = await brief.zoningRun(started.brief.id, OWNER, { ...d, env });
    zoning = z.brief.zoning ? { status: z.brief.zoning.status, reason: z.brief.zoning.reason, kept: z.brief.zoning.kept, jurisdiction: z.brief.zoning.jurisdiction && z.brief.zoning.jurisdiction.label, documents: (z.brief.zoning.documents || []).filter((x) => !x.skipped).length } : null;
    zoningRejected = z.brief.zoning ? (z.brief.zoning.rejected || []).length : null;
  }
  const out = await brief.reasonRun(started.brief.id, OWNER, { ...d, env }, { audit: mode === "C" });
  const b = out.brief;
  const packet = buildPacket(b, { maxBytes: brief.LIMITS.packetMaxBytes }).packet;
  const r = b.reasoning;
  const metrics = claimMetrics(outputText(r && r.output), packet, site.address);
  const validatorRejected = r ? r.rejected.filter((x) => x.reason !== "not_entailed").length : (b.run.inference && b.run.inference.rejected ? b.run.inference.rejected.length : null);
  const auditorRemoved = r && mode === "C" ? r.rejected.filter((x) => x.reason === "not_entailed").length : null;
  const calls = [r && r.model, b.zoning && b.zoning.reader, r && r.audit].filter(Boolean);
  const usd = calls.reduce((s, c) => s + (c.costEstimate && c.costEstimate.usd != null ? c.costEstimate.usd : 0), 0);
  const tokens = calls.reduce((s, c) => s + (c.usage ? (c.usage.inputTokens || 0) + (c.usage.outputTokens || 0) : 0), 0);
  const ok = !!r && (mode !== "C" || (zoning?.status === "read" && ["audited", "nothing_to_audit"].includes(r.audit?.outcome)));
  return {
    mode, ok, error: ok ? null : r ? "full_agent_incomplete" : (b.run.inference && b.run.inference.outcome) || "no_reasoning", inference: b.run.inference && b.run.inference.outcome, siteInput: resolved.input, parcel: b.site.parcel ? b.site.parcel.status : null,
    ...metrics, rejected: { validator: validatorRejected, auditor: auditorRemoved, zoning: zoningRejected },
    audit: r && r.audit ? { outcome: r.audit.outcome, counts: r.audit.verdictCounts } : null,
    zoning, tokens, usd: Math.round(usd * 1e6) / 1e6, latencyMs: Date.now() - t0,
    requestIds: calls.map((c) => c.requestId || null),
  };
  } catch { return { mode, ok: false, error: "benchmark_stage_failed" }; }
  finally { await brief.removeBrief(OWNER, started.brief.id).catch(() => {}); }
}

// The run itself. deps carries scripted collaborators in tests; a live run
// uses the real providers.
export async function runLiveEval({ sites, modes = ["A", "B", "C"], env = process.env, dryRun = false, maxUsd = null, approvedLive = null, deps = {}, log = console.log, now = () => new Date() }) {
  const perSite = estimateSite(modes, env);
  if (!sites.length || !modes.length || !Object.values(perSite).every((v) => Number.isFinite(v) && v > 0)) return { ok: false, error: "invalid_benchmark_plan" };
  const perSiteUsd = Object.values(perSite).reduce((a, b) => a + b, 0);
  const estimateUsd = Math.round(perSiteUsd * sites.length * 1e6) / 1e6;
  const before = await budgetSnapshot({ env, connect: deps.connect });
  const cap = [maxUsd, before.totalRemainingUsd, before.remainingUsd].filter((v) => v != null).reduce((a, b) => Math.min(a, b), Infinity);
  const plan = { sites: sites.length, modes, perSite, estimateUsd, capUsd: cap === Infinity ? null : cap, models: { reasoner: DEFAULT_MODEL, reader: readerModel(env), auditor: auditModel(env) } };
  log("Estimate (reservation upper bound): $" + estimateUsd.toFixed(4) + " for " + sites.length + " sites x modes " + modes.join(",") + " (per site: " + Object.entries(perSite).map(([m, v]) => m + " $" + v.toFixed(4)).join(", ") + ")");
  if (dryRun) return { ok: true, dryRun: true, plan };
  const gate = liveInferenceStatus(env, nebiusStatus(env));
  if (!gate.live) return { ok: false, error: "live_inference_not_configured", reasons: gate.reasons, plan };
  if (!approvedLive || approvedLive !== env.AI_BUDGET_APPROVAL_REFERENCE) return { ok: false, error: "approval_reference_required", note: "Pass --approved-live=<AI_BUDGET_APPROVAL_REFERENCE> after owner gate G2.", plan };
  if (!Number.isFinite(cap) || !(cap > 0)) return { ok: false, error: "no_spending_cap", note: "Pass --max-usd or run against a ledger with an approved remaining amount.", plan };
  if (estimateUsd > cap) return { ok: false, error: "estimate_exceeds_cap", plan };
  if (modes.includes("C")) {
    const tp = tavilyPolicy(env), ts = await tavilySnapshot({ env, connect: deps.connect });
    const credits = sites.length * 3;
    if (!tp.ok || ts.unavailable || tp.total - ts.reservedCredits < credits || tp.daily - ts.dailyReservedCredits < credits) return { ok: false, error: "tavily_batch_allowance_required", plan };
  }
  const results = [];
  const spent = async () => (await budgetSnapshot({ env, connect: deps.connect })).totalSpentUsd - (before.totalSpentUsd || 0);
  const d = { site: deps.site, evidence: deps.evidence, scenarios: deps.scenarios, complete: deps.complete, audit: deps.audit, zoning: deps.zoning, connect: deps.connect };
  const packetFor = async (site) => {
    const resolved = await resolveEvalSite(site, d.site || {});
    if (!resolved.ok) return null;
    const s = await brief.startRun({ site: resolved.site, objective: site.objective, assumptions: {} }, OWNER, { ...d, env });
    if (!s.ok) return null;
    const packet = buildPacket(s.brief, { maxBytes: brief.LIMITS.packetMaxBytes }).packet;
    await brief.removeBrief(OWNER, s.brief.id); return packet;
  };
  // Phase one: mode A on the first sites, then compare spend with its estimate.
  const first = sites.slice(0, PHASE_ONE_SITES);
  if (modes.includes("A")) {
    for (const site of first) {
      const packet = await packetFor(site);
      results.push({ site: site.id, ...(packet ? await runBare(site, packet, { env, complete: deps.complete, connect: deps.connect }) : { mode: "A", ok: false, error: "no_packet" }) });
    }
    const s = await spent();
    if (results.some((r) => !r.ok)) return { ok: false, error: "phase_one_failed", plan, results, spentUsd: s };
    log("Phase one: mode A on " + first.length + " sites spent $" + s.toFixed(6) + " against an estimate of $" + (perSite.A * first.length).toFixed(6));
    if (s > perSite.A * first.length + 1e-9) return { ok: false, error: "phase_one_over_estimate", plan, results, spentUsd: s };
  }
  for (const [i, site] of sites.entries()) {
    if (modes.includes("A") && i >= PHASE_ONE_SITES) {
      const packet = await packetFor(site);
      results.push({ site: site.id, ...(packet ? await runBare(site, packet, { env, complete: deps.complete, connect: deps.connect }) : { mode: "A", ok: false, error: "no_packet" }) });
    }
    for (const mode of modes.filter((m) => m !== "A")) results.push({ site: site.id, ...(await runAgent(mode, site, d, env)) });
    if ((await spent()) > cap) return { ok: false, error: "cap_reached", plan, results, spentUsd: await spent() };
  }
  return { ok: results.every((r) => r.ok), error: results.some((r) => !r.ok) ? "incomplete_modes" : null, plan, results, spentUsd: Math.round((await spent()) * 1e6) / 1e6, finishedAt: now().toISOString() };
}

// Resolve every site through the free providers, one at a time with a pause
// (the geocoder asks for at most one request a second). No model call.
export async function checkSites(sites, { deps = {}, pauseMs = 1200, log = console.log } = {}) {
  const out = [];
  for (const site of sites) {
    const r = await resolveEvalSite(site, deps.site || {});
    const row = { id: site.id, ok: !!r.ok, input: r.input, addressError: r.addressError || null, error: r.ok ? null : r.error, city: r.ok ? r.site.city : null, parcel: r.ok && r.site.parcel ? r.site.parcel.status : null, lotSqft: r.ok && r.site.parcel ? r.site.parcel.lotSqft ?? null : null };
    out.push(row);
    log((row.ok ? "ok   " : "FAIL ") + site.id + "  " + (row.ok ? row.city + " · parcel " + row.parcel + (row.input === "census_point" ? " · by Census point (address " + row.addressError + ")" : "") : row.error));
    if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
  }
  return out;
}

export function summarize(results, modes) {
  return modes.map((mode) => {
    const rs = results.filter((r) => r.mode === mode);
    const sum = (k) => rs.reduce((s, r) => s + (typeof r[k] === "number" ? r[k] : 0), 0);
    const claims = sum("claims"), matched = sum("matched");
    return {
      mode, runs: rs.length, ok: rs.filter((r) => r.ok).length, claims, matched, unsupported: claims - matched,
      unsupportedRate: claims ? Math.round(((claims - matched) / claims) * 1000) / 10 : null,
      validatorRejected: rs.reduce((s, r) => s + (r.rejected && r.rejected.validator || 0), 0),
      auditorRemoved: mode === "C" ? rs.reduce((s, r) => s + (r.rejected && r.rejected.auditor || 0), 0) : null,
      zoningRead: mode === "C" ? rs.filter((r) => r.zoning && r.zoning.status === "read").length : null,
      tokens: sum("tokens"), usd: Math.round(sum("usd") * 1e6) / 1e6,
      medianLatencyMs: rs.length ? rs.map((r) => r.latencyMs || 0).sort((a, b) => a - b)[Math.floor(rs.length / 2)] : null,
    };
  });
}

export function renderMarkdown(run, sites) {
  const rows = summarize(run.results, run.plan.modes);
  const label = { A: "A. Bare model (Super, address only)", B: "B. Packet and validator", C: "C. Full agent (zoning reader and auditor)" };
  const out = [
    "# Site Diligence Agent live evaluation",
    "",
    "Run finished " + run.finishedAt + " by `node scripts/diligence-live-eval.mjs`. " + sites.length + " real Indiana sites from `test/diligence/live-sites.json`. Models: reasoner `" + run.plan.models.reasoner + "`, reader `" + run.plan.models.reader + "`, auditor `" + run.plan.models.auditor + "`, on Nebius Token Factory. Total estimated spend $" + run.spentUsd.toFixed(6) + " (ledger delta; list-price estimate, not an invoice) against an upfront estimate of $" + run.plan.estimateUsd.toFixed(4) + ".",
    "",
    "| Mode | Runs (ok) | Numeric claims | Match packet | Unsupported | Unsupported rate | Validator rejected | Auditor removed | Zoning read | Tokens | Est. cost | Median latency |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => "| " + label[r.mode] + " | " + r.runs + " (" + r.ok + ") | " + r.claims + " | " + r.matched + " | " + r.unsupported + " | " + (r.unsupportedRate == null ? "n/a" : r.unsupportedRate + "%") + " | " + r.validatorRejected + " | " + (r.auditorRemoved == null ? "n/a" : r.auditorRemoved) + " | " + (r.zoningRead == null ? "n/a" : r.zoningRead + " of " + r.runs) + " | " + r.tokens + " | $" + r.usd.toFixed(6) + " | " + (r.medianLatencyMs == null ? "n/a" : r.medianLatencyMs + " ms") + " |"),
    "",
    "## Method",
    "",
    "- The evidence packet is gathered for every site in every mode, each mode gathers separately, and C can add ordinance evidence. Numeric overlap is not proof of truth, units, scope or entailment.",
    "- A numeric claim is any number in the output except years (1900 to 2100), small counts (integers 0 to 12, which the validator also exempts) and numbers in the site's own address. It matches when it is within the validator's tolerance of a packet number: exact, 2% at 100 or more, 0.05 below that, or a fraction written as a percent.",
    "- B and C count numbers only in output the validator accepted; A counts every number in its prose. Reported as measured, including where C does not look better.",
    "- Validator rejected: items the deterministic validator dropped. Auditor removed: findings judged not entailed by their cited rows. Zoning read: sites where at least one ordinance quote matched verbatim.",
    "- Cost and tokens come from each call's reported usage at dated list prices; the total is the shared ledger's delta for the run.",
    "- Sites marked (point) were resolved from their verified Census Geocoder point because the product's address geocoder did not find the address.",
    "",
    "## Per site",
    "",
    "| Site | Mode | Claims | Match | Unsupported | Rejected (validator / auditor / zoning) | Zoning | Tokens | Cost | Latency |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.results.map((r) => "| " + r.site + (r.siteInput === "census_point" ? " (point)" : "") + " | " + r.mode + (r.ok ? "" : " (" + r.error + ")") + " | " + (r.claims ?? "n/a") + " | " + (r.matched ?? "n/a") + " | " + (r.unsupported ?? "n/a") + " | " + [r.rejected && r.rejected.validator, r.rejected && r.rejected.auditor, r.rejected && r.rejected.zoning].map((v) => v == null ? "n/a" : v).join(" / ") + " | " + (r.zoning ? r.zoning.status + (r.zoning.kept ? " (" + r.zoning.kept + ")" : "") : "n/a") + " | " + (r.tokens ?? "n/a") + " | " + (r.usd != null ? "$" + r.usd.toFixed(6) : "n/a") + " | " + (r.latencyMs != null ? r.latencyMs + " ms" : "n/a") + " |"),
    "",
  ];
  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const a = process.argv.find((x) => x.startsWith("--" + name + "=")); return a ? a.slice(name.length + 3) : null; };
  const all = JSON.parse(await readFile(path.join(ROOT, "test/diligence/live-sites.json"), "utf8")).sites;
  const sites = arg("sites") ? all.slice(0, Number(arg("sites"))) : all;
  const modes = (arg("modes") || "A,B,C").split(",").map((m) => m.trim().toUpperCase()).filter((m) => ["A", "B", "C"].includes(m));
  if (process.argv.includes("--check-sites")) { const rows = await checkSites(sites); process.exit(rows.every((r) => r.ok) ? 0 : 1); }
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && (process.env.REDIS_URL || process.env.VERCEL || process.env.NODE_ENV === "production" || !process.env.DILIGENCE_BUDGET_REDIS_URL)) { console.error("Live evaluation requires local draft storage and the existing shared DILIGENCE_BUDGET_REDIS_URL; no new or reset budget ledger."); process.exit(1); }
  const required = Object.values(estimateSite(modes, process.env)).reduce((a,b)=>a+b,0) * sites.length;
  if (!dryRun && !(Number(process.env.DILIGENCE_BENCHMARK_CREDIT_BALANCE_USD) >= required)) { console.error("Verify sufficient provider credit before running the paid benchmark."); process.exit(1); }
  const run = await runLiveEval({ sites, modes, dryRun: process.argv.includes("--dry-run"), maxUsd: arg("max-usd") != null ? Number(arg("max-usd")) : null, approvedLive: arg("approved-live") });
  if (!run.ok && !run.dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await mkdir(path.join(ROOT, "docs/hackathon/receipts"), { recursive: true });
    await writeFile(path.join(ROOT, "docs/hackathon/receipts/live-eval-partial-" + stamp + ".json"), JSON.stringify({ schema: "diligence.live_eval.v1", status: run.results?.length ? "PARTIAL" : "NOT_RUN", ...run }, null, 2) + "\n");
  }
  if (!run.ok || run.dryRun) { console.log(JSON.stringify({ ok: run.ok, dryRun: !!run.dryRun, error: run.error || null, reasons: run.reasons || null, plan: run.plan, spentUsd: run.spentUsd ?? null }, null, 2)); process.exit(run.ok ? 0 : 1); }
  const stamp = run.finishedAt.slice(0, 10).replace(/-/g, "");
  await writeFile(path.join(ROOT, "docs/hackathon/EVAL_LIVE.md"), renderMarkdown(run, sites));
  await mkdir(path.join(ROOT, "docs/hackathon/receipts"), { recursive: true });
  const receipt = { schema: "diligence.live_eval.v1", finishedAt: run.finishedAt, plan: run.plan, spentUsd: run.spentUsd, summary: summarize(run.results, modes), results: run.results };
  await writeFile(path.join(ROOT, "docs/hackathon/receipts/live-eval-" + stamp + ".json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(renderMarkdown(run, sites).split("\n").slice(0, 10).join("\n"));
}
