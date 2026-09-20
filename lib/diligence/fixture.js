// lib/diligence/fixture.js
// Deterministic stand-in for model reasoning, for local demonstration and
// repeatable tests. It is built from the packet by rules, labeled `fixture`
// everywhere it appears, refused on production-like hosts, and never
// described as Nemotron. It is also deliberately written to pass the same
// validator a live answer must pass, so the validator is exercised on every
// fixture run.

import { questionById } from "./objectives.js";

export const FIXTURE_MODEL_ID = "fixture/deterministic-rules-v1";
const IMPACT_RANK = { high: 0, medium: 1, low: 2 };

export function fixtureReasoning(packet) {
  const available = packet.evidence.filter((e) => ["available", "stale", "conflicting"].includes(e.status));
  const siteRows = available.filter((e) => e.applicability === "site");
  const contextRows = available.filter((e) => e.applicability === "context");
  const primary = packet.scenarios[0] || null;
  const unknowns = [...packet.unknowns].sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact]);
  const highUnknowns = unknowns.filter((u) => u.impact === "high");
  const executive = [
    "This is a fixture interpretation produced by rules, not by a language model.",
    "Site evidence resolved for " + siteRows.length + " site-level records and " + contextRows.length + " context records; " + packet.evidence.filter((e) => e.status === "unavailable").length + " required or expected records are unavailable.",
    primary ? "The primary scenario is " + primary.readiness.replace(/_/g, " ") + (primary.outputs.units != null ? " with " + primary.outputs.units + " units on " + primary.outputs.grossSqft + " gross square feet." : ".") : "No scenario could be screened.",
    highUnknowns.length ? "The decisive unknowns are entitlement, site condition, and market inputs that no source in this brief establishes." : "No high-impact unknowns were recorded.",
    "The next step is verification, not commitment.",
  ].join(" ");
  const findings = [...siteRows.slice(0, 3), ...contextRows.slice(0, 2)].map((e) => ({ statement: e.text, evidence_ids: [e.id] }));
  const comparison = packet.scenarios.map((s) => ({
    scenario_id: s.id,
    fit: s.readiness === "not_screenable" ? "not_assessable" : s.variant === "primary" ? "comparable" : (s.outputs.surfaceParkingFits === true && primary && primary.outputs.surfaceParkingFits === false ? "stronger" : "comparable"),
    rationale: s.readiness === "not_screenable" ? "No lot area, so the program cannot be sized." : (s.variant === "primary" ? "Primary program as configured; readiness " + s.readiness.replace(/_/g, " ") + "." : (s.differsBy || "Comparator.") + " Readiness " + s.readiness.replace(/_/g, " ") + "."),
    evidence_ids: packet.evidence.filter((e) => e.key === "parcel_lot_area" && e.value != null).map((e) => e.id).slice(0, 1),
    assumption_ids: packet.assumptions.filter((a) => ["coveragePct", "floors", "unitSqft"].includes(a.key) && a.value != null).map((a) => a.id).slice(0, 3),
  }));
  const decisive = unknowns.slice(0, 6).map((u) => ({ unknown_id: u.id, statement: u.statement, impact: u.impact, why: u.applicability === "site" ? "A site-level fact the scenario depends on is not established by any source in this brief." : "City or county context that frames demand is not established or is dated." }));
  const conflicts = packet.conflicts.slice(0, 4).map((c) => ({ statement: c.statement, evidence_ids: c.evidenceIds.slice(0, 6) }));
  const plan = packet.questions
    .map((q) => ({ q, lib: questionById(q.id) }))
    .filter((x) => x.lib)
    .sort((a, b) => IMPACT_RANK[a.lib.impact] - IMPACT_RANK[b.lib.impact])
    .slice(0, 8)
    .map((x, i) => ({ question_id: x.q.id, priority: i + 1, impact: x.lib.impact, verification_method: x.lib.method, rationale: "Ranked by the library impact tier; no model judgment was applied." }));
  const sensitivity = packet.assumptions
    .filter((a) => ["hardCostPerSqft", "rentPerSqftMonth", "floors", "coveragePct", "capRatePct"].includes(a.key) && a.value != null)
    .slice(0, 5)
    .map((a) => ({ assumption_id: a.id, effect: a.label + " drives the screen directly; it is a " + a.basis.replace(/_/g, " ") + ".", direction: "unclear" }));
  const limitations = [
    "Fixture interpretation: produced by fixed rules for demonstration and testing, not by a model.",
    "City and county records are context and do not describe the parcel.",
    "Nothing here determines zoning compliance, entitlement, feasibility, or financial performance.",
  ];
  return { executive_assessment: executive, supported_findings: findings, scenario_comparison: comparison, decisive_unknowns: decisive, conflicts, investigation_plan: plan, assumption_sensitivity: sensitivity, limitations };
}
