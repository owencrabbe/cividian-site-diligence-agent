// lib/diligence/diff.js
// Change classification between two evidence sets for the same site. The
// classes are deliberately about the evidence pipeline, not the world: a source
// answering differently, a source failing to answer, a source no longer
// producing a row, an adapter version change, and a new row. None of them is a
// "site change", and the brief never labels them as one.

export const CHANGE_CLASSES = ["unchanged", "source_changed", "fetch_failed", "source_disappeared", "extraction_changed", "new_record"];
const OK = (s) => ["available", "stale", "conflicting", "unverified"].includes(s);

function summary(r) {
  return r ? { status: r.status, value: r.value, hash: r.hash || null, retrievedAt: r.retrievedAt || null, vintage: r.vintage || null, extractionVersion: r.extractionVersion || null } : null;
}

export function classifyChanges(before, after) {
  const prev = new Map((before || []).map((r) => [r.id, r]));
  const next = new Map((after || []).map((r) => [r.id, r]));
  const out = [];
  for (const [id, b] of prev) {
    const a = next.get(id);
    let cls;
    if (!a) cls = "source_disappeared";
    else if (OK(b.status) && !OK(a.status)) cls = "fetch_failed";
    else if ((b.extractionVersion || null) !== (a.extractionVersion || null)) cls = "extraction_changed";
    else if ((b.hash || null) !== (a.hash || null) || b.value !== a.value || b.status !== a.status || (b.text || "") !== (a.text || "")) cls = "source_changed";
    else cls = "unchanged";
    out.push({ evidenceId: id, key: b.key, class: cls, before: summary(b), after: summary(a) });
  }
  for (const [id, a] of next) if (!prev.has(id)) out.push({ evidenceId: id, key: a.key, class: "new_record", before: null, after: summary(a) });
  const counts = {};
  for (const c of CHANGE_CLASSES) counts[c] = out.filter((x) => x.class === c).length;
  return { changes: out, counts, material: out.filter((x) => x.class !== "unchanged").length };
}

// Interpretation comparison: a stable digest of the validated reasoning so a
// re-run can say whether the model's reading changed even when evidence did not.
export function interpretationDigest(reasoning) {
  if (!reasoning || !reasoning.output) return null;
  const o = reasoning.output;
  const shape = {
    findings: (o.supported_findings || []).map((f) => f.evidence_ids.slice().sort()),
    comparison: (o.scenario_comparison || []).map((s) => [s.scenario_id, s.fit]),
    plan: (o.investigation_plan || []).map((p) => [p.question_id, p.priority, p.impact]),
    unknowns: (o.decisive_unknowns || []).map((u) => [u.unknown_id, u.impact]),
  };
  return JSON.stringify(shape);
}
