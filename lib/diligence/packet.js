// lib/diligence/packet.js
// The bounded evidence packet the model reasons over. Everything in it is
// addressed by an id the validator can check, every string is sanitized and
// length-capped, and third-party text (parcel addresses, provider notes,
// geocoder place names) is carried as data fields inside JSON, never as
// instructions. The packet is hashed so a saved brief records exactly what the
// model saw.

import { createHash } from "node:crypto";

export const PACKET_SCHEMA = "diligence.packet.v1";
export const PACKET_MAX_BYTES = 24000;

export function sanitizeText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    // Angle brackets are never meaningful in evidence text and would let a
    // hostile source smuggle markup through a model that quotes it.
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const numeric = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function packetEvidence(r, textMax) {
  return {
    id: r.id,
    kind: r.kind,
    key: r.key,
    scope: r.scope.level,
    applicability: r.applicability,
    status: r.status,
    freshness: r.freshness,
    vintage: r.vintage || null,
    value: numeric(r.value),
    units: r.units || null,
    text: sanitizeText(r.text, textMax),
  };
}

function packetScenario(s) {
  const o = s.outputs || {};
  return {
    id: s.id,
    label: sanitizeText(s.label, 60),
    variant: s.variant,
    differsBy: s.differsBy ? sanitizeText(s.differsBy, 160) : null,
    readiness: s.readiness ? s.readiness.category : null,
    outputs: {
      footprintSqft: numeric(o.footprintSqft), grossSqft: numeric(o.grossSqft), netSqft: numeric(o.netSqft), units: numeric(o.units), retailNetSqft: numeric(o.retailNetSqft),
      parkingSpaces: numeric(o.parkingSpaces), parkingAreaSqft: numeric(o.parkingAreaSqft), surfaceParkingFits: typeof o.surfaceParkingFits === "boolean" ? o.surfaceParkingFits : null,
      knownCostSubtotal: numeric(o.knownCostSubtotal), totalDevelopmentCost: numeric(o.totalDevelopmentCost), noi: numeric(o.noi), yieldOnCost: numeric(o.yieldOnCost), capRate: numeric(o.capRate), spread: numeric(o.spread),
    },
    uncertainties: (s.uncertainties || []).slice(0, 4).map((u) => sanitizeText(u, 160)),
  };
}

export function buildPacket(brief, opts = {}) {
  const maxBytes = opts.maxBytes || PACKET_MAX_BYTES;
  const truncated = [];
  const make = (evidenceTextMax, questionText, unavailableTextMax) => ({
    schema: PACKET_SCHEMA,
    objective: { id: brief.objective.id, label: brief.objective.label, description: sanitizeText(brief.objective.description, 200) },
    site: {
      kind: brief.site.kind,
      city: brief.site.city ? sanitizeText(brief.site.city, 60) : null,
      state: brief.site.state || null,
      county: brief.site.county ? sanitizeText(brief.site.county.name, 60) : null,
      pointPrecision: brief.site.point ? brief.site.point.precision : null,
      parcelStatus: brief.site.parcel ? brief.site.parcel.status : null,
      parcelAddress: brief.site.parcel && brief.site.parcel.address ? sanitizeText(brief.site.parcel.address, 120) : null,
    },
    assumptions: brief.assumptions.map((a) => ({ id: a.id, key: a.key, label: sanitizeText(a.label, 80), value: numeric(a.value), units: a.units, basis: a.basis })),
    evidence: brief.evidence.map((r) => packetEvidence(r, r.status === "unavailable" ? unavailableTextMax : evidenceTextMax)),
    scenarios: brief.scenarios.map(packetScenario),
    unknowns: brief.unknowns.map((u) => ({ id: u.id, applicability: u.applicability, impact: u.impact, statement: sanitizeText(u.statement, 160) })),
    conflicts: brief.conflicts.map((c) => ({ id: c.id, statement: sanitizeText(c.statement, 200), evidenceIds: c.evidenceIds || [], assumptionIds: c.assumptionIds || [] })),
    questions: brief.questionLibrary.map((q) => (questionText ? { id: q.id, area: q.area, impact: q.impact, text: sanitizeText(q.text, 160) } : { id: q.id, area: q.area, impact: q.impact })),
  });
  let packet = make(200, true, 120);
  let json = JSON.stringify(packet);
  if (Buffer.byteLength(json) > maxBytes) { packet = make(120, true, 60); json = JSON.stringify(packet); truncated.push("evidence_text_shortened"); }
  if (Buffer.byteLength(json) > maxBytes) { packet = make(120, false, 60); json = JSON.stringify(packet); truncated.push("question_text_dropped"); }
  if (Buffer.byteLength(json) > maxBytes) { packet = make(80, false, 40); json = JSON.stringify(packet); truncated.push("evidence_text_minimal"); }
  const bytes = Buffer.byteLength(json);
  return { packet, json, bytes, hash: createHash("sha256").update(json).digest("hex"), truncated, overBudget: bytes > maxBytes };
}

// Every id the model is allowed to reference, grouped by kind.
export function packetIds(packet) {
  return {
    evidence: new Set(packet.evidence.map((e) => e.id)),
    scenarios: new Set(packet.scenarios.map((s) => s.id)),
    assumptions: new Set(packet.assumptions.map((a) => a.id)),
    unknowns: new Set(packet.unknowns.map((u) => u.id)),
    questions: new Set(packet.questions.map((q) => q.id)),
  };
}
