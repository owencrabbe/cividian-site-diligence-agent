// lib/diligence/schema.js
// The strict output contract for model reasoning (diligence.reasoning.v1) and
// the validator that decides what of a model's answer may enter the brief.
//
// The validator is the load-bearing part. A model answer is text; the brief is
// evidence. The only way text crosses that line is by citing ids the packet
// declared, using numbers that appear in what it cited, adding no links, no
// markup, no new facts, and no verdict. Items that fail are dropped and the
// reason is recorded so the brief can show what was rejected. If nothing
// survives, the brief ships without model interpretation rather than with a
// polished paragraph nobody can audit.

import { packetIds } from "./packet.js";

export const REASONING_SCHEMA_ID = "diligence.reasoning.v1";
const IMPACT = ["high", "medium", "low"];
const FIT = ["stronger", "weaker", "comparable", "not_assessable"];
const DIRECTION = ["increases_risk", "decreases_risk", "unclear"];
const str = (max) => ({ type: "string", maxLength: max });
const ids = (max) => ({ type: "array", items: { type: "string", maxLength: 80 }, maxItems: max });

// JSON Schema 2020-12, kept to the subset guided decoders accept: objects with
// every property required, no anyOf, additionalProperties false.
export const REASONING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["executive_assessment", "supported_findings", "scenario_comparison", "decisive_unknowns", "conflicts", "investigation_plan", "assumption_sensitivity", "limitations"],
  properties: {
    executive_assessment: str(900),
    supported_findings: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["statement", "evidence_ids"], properties: { statement: str(320), evidence_ids: ids(6) } } },
    scenario_comparison: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["scenario_id", "fit", "rationale", "evidence_ids", "assumption_ids"], properties: { scenario_id: str(80), fit: { type: "string", enum: FIT }, rationale: str(320), evidence_ids: ids(6), assumption_ids: ids(6) } } },
    decisive_unknowns: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["unknown_id", "statement", "impact", "why"], properties: { unknown_id: str(80), statement: str(240), impact: { type: "string", enum: IMPACT }, why: str(240) } } },
    conflicts: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["statement", "evidence_ids"], properties: { statement: str(240), evidence_ids: ids(6) } } },
    investigation_plan: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["question_id", "priority", "impact", "verification_method", "rationale"], properties: { question_id: str(80), priority: { type: "integer", minimum: 1, maximum: 8 }, impact: { type: "string", enum: IMPACT }, verification_method: str(240), rationale: str(240) } } },
    assumption_sensitivity: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["assumption_id", "effect", "direction"], properties: { assumption_id: str(80), effect: str(240), direction: { type: "string", enum: DIRECTION } } } },
    limitations: { type: "array", maxItems: 6, items: str(240) },
  },
};

// A compact, prompt-friendly restatement. Nebius recommends the schema appear
// in the prompt as well as in response_format.
export const REASONING_SCHEMA_PROMPT = [
  "Return one JSON object with exactly these keys:",
  "executive_assessment (string, at most 900 characters, no verdict),",
  "supported_findings (array of {statement, evidence_ids[]}, at most 8; every statement must be supported by the cited evidence ids),",
  "scenario_comparison (array of {scenario_id, fit: stronger|weaker|comparable|not_assessable, rationale, evidence_ids[], assumption_ids[]}, one per scenario id),",
  "decisive_unknowns (array of {unknown_id (an unknown id from the packet, or empty string), statement, impact: high|medium|low, why}, at most 8),",
  "conflicts (array of {statement, evidence_ids[]}, at most 4; empty if none),",
  "investigation_plan (array of {question_id (from the question library), priority 1..8, impact: high|medium|low, verification_method, rationale}, at most 8, ordered by decision impact),",
  "assumption_sensitivity (array of {assumption_id, effect, direction: increases_risk|decreases_risk|unclear}, at most 6),",
  "limitations (array of strings, at most 6).",
  "Use only ids that appear in the packet. Use only numbers that appear in the packet. Do not include URLs, markup, or a pursue, watch, or pass determination.",
  "Citation types are exact: evidence_ids contains only literal evidence[].id values, assumption_ids only assumptions[].id values, and scenario_id only a scenarios[].id. Never put a scenario id, output name, or dotted property path in evidence_ids. A scenario's own outputs are already cited by scenario_id, so its evidence_ids may be empty.",
  "Supported findings may cite only evidence with status available, stale, or conflicting. Unverified parcel candidates and unavailable rows belong in unknowns or limitations, not supported_findings. Keep missing evidence explicit and do not describe it as a confirmed fact.",
].join(" ");

const URL_RE = /https?:\/\/|www\.|\.(com|org|net|gov)\b/i;
const MARKUP_RE = /<\s*\/?\s*[a-z!]/i;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const VERDICT_RE = /\b(PURSUE|PASS|WATCH)\b|\b(recommend(?:ed|ation|s)?|verdict|decision|call)\b[^.]{0,40}\b(pursue|pass|watch)\b|\b(pursue|pass|watch)\b[^.]{0,20}\b(verdict|decision|recommendation)\b/;
const NUMBER_RE = /(?<![A-Za-z_])\$?\d[\d,]*(?:\.\d+)?%?/g;

function badText(s, max) {
  if (typeof s !== "string") return "not_a_string";
  if (s.length > max) return "too_long";
  if (CONTROL_RE.test(s)) return "control_characters";
  if (MARKUP_RE.test(s)) return "markup";
  if (URL_RE.test(s)) return "url";
  if (VERDICT_RE.test(s)) return "verdict_language";
  return null;
}

export function numbersIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(NUMBER_RE)) {
    const raw = m[0].replace(/[$,%]/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// The numbers a cited item makes available: its value, every number in its
// text, and for a scenario every numeric output. Rounded variants are
// generated by the tolerance check rather than enumerated here.
function allowedNumbers(packet, cited) {
  const set = [];
  const push = (v) => { if (typeof v === "number" && Number.isFinite(v)) set.push(v); };
  for (const e of packet.evidence) if (cited.evidence.has(e.id)) { push(e.value); numbersIn(e.text).forEach(push); }
  for (const s of packet.scenarios) if (cited.scenarios.has(s.id)) { Object.values(s.outputs).forEach(push); s.uncertainties.forEach((u) => numbersIn(u).forEach(push)); }
  for (const a of packet.assumptions) if (cited.assumptions.has(a.id)) push(a.value);
  for (const u of packet.unknowns) if (cited.unknowns.has(u.id)) numbersIn(u.statement).forEach(push);
  return set;
}

function everyNumberAllowed(text, allowed) {
  for (const n of numbersIn(text)) {
    if (Number.isInteger(n) && n >= 0 && n <= 12) continue;
    const ok = allowed.some((a) => a === n || (Math.abs(a) >= 100 && Math.abs(a - n) / Math.abs(a) <= 0.02) || (Math.abs(a) < 100 && Math.abs(a - n) <= 0.05) || (a > 0 && a < 1 && Math.abs(a * 100 - n) <= 0.05));
    if (!ok) return n;
  }
  return null;
}

const SCOPE_RANK = { parcel: 4, point: 3, site: 3, county: 2, city: 1 };
function narrowestScope(packet, evidenceIds) {
  let best = null;
  for (const e of packet.evidence) if (evidenceIds.includes(e.id)) { if (!best || SCOPE_RANK[e.scope] > SCOPE_RANK[best]) best = e.scope; }
  return best;
}

function uniqueStrings(arr, max) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const v of arr) { if (typeof v !== "string") return null; if (!out.includes(v)) out.push(v); }
  return out.length > max ? null : out;
}

// Validate a parsed model object against the packet it was given.
// Returns { ok, value, rejected: [{ path, reason, detail }], accepted: n }.
export function validateReasoning(raw, packet) {
  const rejected = [];
  const reject = (path, reason, detail) => rejected.push({ path, reason, detail: detail == null ? null : String(detail).slice(0, 120) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, value: null, rejected: [{ path: "$", reason: "not_an_object", detail: null }], accepted: 0 };
  for (const key of Object.keys(raw)) if (!REASONING_SCHEMA.required.includes(key)) reject("$." + key, "unknown_field");
  const known = packetIds(packet);
  const all = { evidence: known.evidence, scenarios: known.scenarios, assumptions: known.assumptions, unknowns: known.unknowns };
  const everything = allowedNumbers(packet, all);
  const value = { schema: REASONING_SCHEMA_ID, executive_assessment: null, supported_findings: [], scenario_comparison: [], decisive_unknowns: [], conflicts: [], investigation_plan: [], assumption_sensitivity: [], limitations: [] };
  let accepted = 0;

  // executive_assessment: free prose, but every number must exist somewhere in the packet.
  const ea = raw.executive_assessment;
  const eaBad = badText(ea, 900);
  if (eaBad) reject("$.executive_assessment", eaBad);
  else if (!ea.trim()) reject("$.executive_assessment", "empty");
  else { const n = everyNumberAllowed(ea, everything); if (n != null) reject("$.executive_assessment", "uncited_number", n); else { value.executive_assessment = ea.trim(); accepted++; } }

  // supported_findings
  if (Array.isArray(raw.supported_findings)) raw.supported_findings.slice(0, 8).forEach((f, i) => {
    const path = "$.supported_findings[" + i + "]";
    if (!f || typeof f !== "object") return reject(path, "not_an_object");
    const bad = badText(f.statement, 320); if (bad) return reject(path, bad);
    const cited = uniqueStrings(f.evidence_ids, 6); if (!cited || !cited.length) return reject(path, "no_citations");
    const unknown = cited.filter((id) => !known.evidence.has(id)); if (unknown.length) return reject(path, "fabricated_citation", unknown.join(","));
    const available = packet.evidence.filter((e) => cited.includes(e.id) && ["available", "stale", "conflicting"].includes(e.status));
    if (!available.length) return reject(path, "cites_only_unavailable_evidence");
    const n = everyNumberAllowed(f.statement, allowedNumbers(packet, { evidence: new Set(cited), scenarios: new Set(), assumptions: new Set(), unknowns: new Set() })); if (n != null) return reject(path, "uncited_number", n);
    value.supported_findings.push({ statement: f.statement.trim(), evidence_ids: cited, scope: narrowestScope(packet, cited), stale: available.some((e) => e.status === "stale") }); accepted++;
  }); else if (raw.supported_findings !== undefined) reject("$.supported_findings", "not_an_array");

  // scenario_comparison
  const seenScenario = new Set();
  if (Array.isArray(raw.scenario_comparison)) raw.scenario_comparison.slice(0, 4).forEach((s, i) => {
    const path = "$.scenario_comparison[" + i + "]";
    if (!s || typeof s !== "object") return reject(path, "not_an_object");
    if (!known.scenarios.has(s.scenario_id)) return reject(path, "fabricated_scenario_id", s.scenario_id);
    if (seenScenario.has(s.scenario_id)) return reject(path, "duplicate_scenario");
    if (!FIT.includes(s.fit)) return reject(path, "bad_enum", s.fit);
    const bad = badText(s.rationale, 320); if (bad) return reject(path, bad);
    const ev = uniqueStrings(s.evidence_ids, 6), as = uniqueStrings(s.assumption_ids, 6); if (!ev || !as) return reject(path, "bad_citation_list");
    const unknown = [...ev.filter((id) => !known.evidence.has(id)), ...as.filter((id) => !known.assumptions.has(id))]; if (unknown.length) return reject(path, "fabricated_citation", unknown.join(","));
    const n = everyNumberAllowed(s.rationale, allowedNumbers(packet, { evidence: new Set(ev), scenarios: new Set([s.scenario_id]), assumptions: new Set(as), unknowns: new Set() })); if (n != null) return reject(path, "uncited_number", n);
    seenScenario.add(s.scenario_id);
    value.scenario_comparison.push({ scenario_id: s.scenario_id, fit: s.fit, rationale: s.rationale.trim(), evidence_ids: ev, assumption_ids: as }); accepted++;
  }); else if (raw.scenario_comparison !== undefined) reject("$.scenario_comparison", "not_an_array");

  // decisive_unknowns
  if (Array.isArray(raw.decisive_unknowns)) raw.decisive_unknowns.slice(0, 8).forEach((u, i) => {
    const path = "$.decisive_unknowns[" + i + "]";
    if (!u || typeof u !== "object") return reject(path, "not_an_object");
    if (typeof u.unknown_id !== "string") return reject(path, "bad_unknown_id");
    if (u.unknown_id && !known.unknowns.has(u.unknown_id)) return reject(path, "fabricated_unknown_id", u.unknown_id);
    if (!IMPACT.includes(u.impact)) return reject(path, "bad_enum", u.impact);
    for (const k of ["statement", "why"]) { const bad = badText(u[k], 240); if (bad) return reject(path + "." + k, bad); }
    const n = everyNumberAllowed(u.statement + " " + u.why, everything); if (n != null) return reject(path, "uncited_number", n);
    value.decisive_unknowns.push({ unknown_id: u.unknown_id || null, statement: u.statement.trim(), impact: u.impact, why: u.why.trim() }); accepted++;
  }); else if (raw.decisive_unknowns !== undefined) reject("$.decisive_unknowns", "not_an_array");

  // conflicts
  if (Array.isArray(raw.conflicts)) raw.conflicts.slice(0, 4).forEach((c, i) => {
    const path = "$.conflicts[" + i + "]";
    if (!c || typeof c !== "object") return reject(path, "not_an_object");
    const bad = badText(c.statement, 240); if (bad) return reject(path, bad);
    const cited = uniqueStrings(c.evidence_ids, 6); if (!cited || cited.length < 1) return reject(path, "no_citations");
    const unknown = cited.filter((id) => !known.evidence.has(id)); if (unknown.length) return reject(path, "fabricated_citation", unknown.join(","));
    const n = everyNumberAllowed(c.statement, allowedNumbers(packet, { evidence: new Set(cited), scenarios: new Set(), assumptions: new Set(), unknowns: new Set() })); if (n != null) return reject(path, "uncited_number", n);
    value.conflicts.push({ statement: c.statement.trim(), evidence_ids: cited }); accepted++;
  }); else if (raw.conflicts !== undefined) reject("$.conflicts", "not_an_array");

  // investigation_plan
  const seenQ = new Set();
  if (Array.isArray(raw.investigation_plan)) raw.investigation_plan.slice(0, 8).forEach((p, i) => {
    const path = "$.investigation_plan[" + i + "]";
    if (!p || typeof p !== "object") return reject(path, "not_an_object");
    if (!known.questions.has(p.question_id)) return reject(path, "fabricated_question_id", p.question_id);
    if (seenQ.has(p.question_id)) return reject(path, "duplicate_question");
    if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 8) return reject(path, "bad_priority", p.priority);
    if (!IMPACT.includes(p.impact)) return reject(path, "bad_enum", p.impact);
    for (const k of ["verification_method", "rationale"]) { const bad = badText(p[k], 240); if (bad) return reject(path + "." + k, bad); }
    const n = everyNumberAllowed(p.rationale + " " + p.verification_method, everything); if (n != null) return reject(path, "uncited_number", n);
    seenQ.add(p.question_id);
    value.investigation_plan.push({ question_id: p.question_id, priority: p.priority, impact: p.impact, verification_method: p.verification_method.trim(), rationale: p.rationale.trim() }); accepted++;
  }); else if (raw.investigation_plan !== undefined) reject("$.investigation_plan", "not_an_array");
  value.investigation_plan.sort((a, b) => a.priority - b.priority).forEach((p, i) => { p.priority = i + 1; });

  // assumption_sensitivity
  const seenA = new Set();
  if (Array.isArray(raw.assumption_sensitivity)) raw.assumption_sensitivity.slice(0, 6).forEach((a, i) => {
    const path = "$.assumption_sensitivity[" + i + "]";
    if (!a || typeof a !== "object") return reject(path, "not_an_object");
    if (!known.assumptions.has(a.assumption_id)) return reject(path, "fabricated_assumption_id", a.assumption_id);
    if (seenA.has(a.assumption_id)) return reject(path, "duplicate_assumption");
    if (!DIRECTION.includes(a.direction)) return reject(path, "bad_enum", a.direction);
    const bad = badText(a.effect, 240); if (bad) return reject(path, bad);
    const n = everyNumberAllowed(a.effect, everything); if (n != null) return reject(path, "uncited_number", n);
    seenA.add(a.assumption_id);
    value.assumption_sensitivity.push({ assumption_id: a.assumption_id, effect: a.effect.trim(), direction: a.direction }); accepted++;
  }); else if (raw.assumption_sensitivity !== undefined) reject("$.assumption_sensitivity", "not_an_array");

  // limitations
  if (Array.isArray(raw.limitations)) raw.limitations.slice(0, 6).forEach((l, i) => {
    const bad = badText(l, 240); if (bad) return reject("$.limitations[" + i + "]", bad);
    const n = everyNumberAllowed(l, everything); if (n != null) return reject("$.limitations[" + i + "]", "uncited_number", n);
    value.limitations.push(l.trim()); accepted++;
  }); else if (raw.limitations !== undefined) reject("$.limitations", "not_an_array");

  // Miscitation is dropped item by item. Rule-breaking is different: a verdict,
  // a link, or markup anywhere means the model ignored its instructions, and an
  // answer that ignored them once is not trusted in part.
  const HARD = ["verdict_language", "url", "markup", "control_characters"];
  const hard = rejected.filter((r) => HARD.includes(r.reason));
  if (hard.length) return { ok: false, value: null, rejected, accepted: 0, hardRejection: hard.map((r) => r.reason) };
  const ok = accepted > 0 && (value.executive_assessment != null || value.supported_findings.length > 0 || value.investigation_plan.length > 0);
  return { ok, value: ok ? value : null, rejected, accepted, hardRejection: [] };
}
