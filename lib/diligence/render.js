// lib/diligence/render.js
// A self-contained, printable HTML rendering of one diligence.brief.v1. Every
// string passes through esc(); every link through safeHref(); nothing is read
// from anywhere but the brief object, so the export can never disagree with
// the saved JSON. Print to PDF from the browser.

export function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function safeHref(v) {
  if (typeof v !== "string" || v.length > 2000) return null;
  try { const u = new URL(v); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const money = (n) => (n == null ? "null" : "$" + Number(n).toLocaleString("en-US"));
const num = (n, d = 0) => (n == null ? "null" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));
const pct = (n) => (n == null ? "null" : (Number(n) * 100).toFixed(2) + "%");
const date = (iso) => (iso ? String(iso).slice(0, 19).replace("T", " ") + " UTC" : "not recorded");

function evidenceRow(r) {
  const href = safeHref(r.source && r.source.url);
  return `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.fact)}<div class="fine">${esc(r.text)}</div></td><td>${esc(r.scope.level)} <span class="tag">${esc(r.applicability)}</span></td><td><span class="status s-${esc(r.status)}">${esc(r.status)}</span></td><td>${href ? `<a href="${esc(href)}">${esc(r.source.name)}</a>` : esc(r.source.name)}<div class="fine">${esc(r.source.authority)} / ${esc(r.extraction)}</div></td><td>${esc(r.vintage || "n/a")}<div class="fine">retrieved ${esc(date(r.retrievedAt))}</div></td></tr>`;
}

export function renderBriefHtml(brief) {
  const b = brief;
  const site = b.site || {};
  const model = b.reasoning ? b.reasoning.model : null;
  const basis = b.reasoning ? b.reasoning.basis : "none";
  const modelLabel = basis === "fixture" ? "FIXTURE INTERPRETATION (rules, not a model)" : basis === "model_interpretation" ? "Model interpretation: " + (model ? model.requestedModel + " on " + model.provider : "model") : "No model interpretation in this brief";
  const q = (id) => (b.questionLibrary || []).find((x) => x.id === id) || { text: id, method: "", source: "" };
  const primary = (b.scenarios || [])[0];
  const plan = b.reasoning && b.reasoning.output && b.reasoning.output.investigation_plan.length ? b.reasoning.output.investigation_plan.map((p) => ({ ...p, lib: q(p.question_id), basis })) : (b.baselinePlan || []).map((p) => ({ question_id: p.questionId, priority: p.priority, impact: p.impact, verification_method: p.method, rationale: p.reason, lib: { text: p.question, source: p.source }, basis: "rules" }));
  const out = [];
  out.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Diligence brief: ${esc(site.parcel && site.parcel.address ? site.parcel.address : site.query || "site")}</title>
<style>
:root{--ink:#111b1a;--forest:#284b3c;--stone:#f3f0e8;--paper:#fffefa;--muted:#64706b;--line:#dcded4;--warn:#8a5a19;--bad:#98483c}
*{box-sizing:border-box}body{margin:0;background:var(--stone);color:var(--ink);font:14px/1.55 "DM Sans",system-ui,sans-serif}
.page{max-width:960px;margin:0 auto;background:var(--paper);padding:40px 48px}h1{font-size:28px;letter-spacing:-.8px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 10px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:14px;margin:18px 0 6px}
.eyebrow{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--forest);font-weight:650}.fine{font-size:11px;color:var(--muted)}.tag{font-size:10px;border:1px solid var(--line);border-radius:3px;padding:1px 5px;margin-left:4px}
.banner{padding:12px 16px;border-left:4px solid var(--warn);background:#fbf4e6;margin:18px 0;font-size:13px}.banner.fixture{border-color:var(--bad);background:#fbeceb}
table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--line)}th{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.status{font-size:10px;font-weight:650;padding:2px 6px;border-radius:3px;background:#e7ede4}.s-unavailable{background:#f0e6e4}.s-stale{background:#f6ecd8}.s-conflicting{background:#f6ddd8}.s-unverified{background:#ecebe0}
code{font-size:11px;background:#eef0e8;padding:1px 4px;border-radius:3px}ol,ul{padding-left:20px}li{margin:6px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 32px}dl{margin:0}dt{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}dd{margin:0 0 8px}
.model{border-left:3px solid var(--forest);padding:8px 14px;background:#f2f5ef}.model .fine{margin-top:6px}.cite{color:var(--forest);font-size:11px}
@media print{body{background:#fff}.page{padding:0;max-width:none}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body><div class="page">`);
  out.push(`<p class="eyebrow">Cividian Site Diligence Agent · diligence.brief.v1 · brief ${esc(b.id)} v${esc(b.version)}</p>`);
  out.push(`<h1>${esc(site.parcel && site.parcel.address ? site.parcel.address : site.query || "Site")}</h1><p class="fine">${esc(site.city || "city unbound")}${site.state ? ", " + esc(site.state) : ""}${site.county ? " · " + esc(site.county.name) : ""} · ${esc(b.objective.label)} · generated ${esc(date(b.updatedAt))}</p>`);
  out.push(`<div class="banner${basis === "fixture" ? " fixture" : ""}"><strong>${esc(modelLabel)}.</strong> Decision support only. This brief does not determine legal entitlement, zoning compliance, investment suitability, engineering feasibility, or financial performance. Every number carries its source; missing values are null, never zero.</div>`);

  out.push(`<h2>1. Site identity and objective</h2><div class="grid"><dl><dt>Query</dt><dd>${esc(site.query || "map point")}</dd><dt>Point</dt><dd>${esc(site.point ? site.point.lat + ", " + site.point.lon + " (" + site.point.precision + ", " + site.point.source + ")" : "n/a")}</dd><dt>Parcel</dt><dd>${esc(site.parcel ? site.parcel.status.replace(/_/g, " ") : "none")}${site.parcel && site.parcel.id ? " · id " + esc(site.parcel.id) : ""}${site.parcel && site.parcel.lotSqft != null ? " · " + esc(num(site.parcel.lotSqft)) + " sq ft (" + esc(site.parcel.lotSqftBasis || "") + ")" : ""}<div class="fine">${esc(site.parcel && site.parcel.note || "")}</div></dd></dl><dl><dt>Objective</dt><dd>${esc(b.objective.label)}<div class="fine">${esc(b.objective.description)}</div></dd><dt>Evidence coverage</dt><dd>${esc(primary && primary.coverage ? primary.coverage.category + " (" + primary.coverage.siteAvailable + "/" + primary.coverage.siteRequired + " site keys, " + primary.coverage.contextAvailable + "/" + primary.coverage.contextRequired + " context keys)" : "n/a")}</dd><dt>Brief status</dt><dd>${esc(b.status)}</dd></dl></div>`);
  for (const w of site.warnings || []) out.push(`<p class="banner">${esc(w)}</p>`);

  out.push(`<h2>2. Executive assessment</h2>`);
  if (b.reasoning && b.reasoning.output && b.reasoning.output.executive_assessment) out.push(`<div class="model"><p>${esc(b.reasoning.output.executive_assessment)}</p><p class="fine">${esc(modelLabel)}. Validated against packet ${esc((b.run.packetHash || "").slice(0, 12))}.</p></div>`);
  out.push(`<p>${esc(b.summary)}</p>`);

  out.push(`<h2>3. What the evidence supports</h2>`);
  if (b.reasoning && b.reasoning.output && b.reasoning.output.supported_findings.length) {
    out.push(`<ul>` + b.reasoning.output.supported_findings.map((f) => `<li>${esc(f.statement)} <span class="cite">[${f.evidence_ids.map(esc).join(", ")}]</span> <span class="tag">${esc(f.scope || "")} scope</span>${f.stale ? '<span class="tag">stale vintage</span>' : ""}</li>`).join("") + `</ul>`);
  }
  out.push(`<h3>Available records</h3><ul>` + (b.evidence || []).filter((r) => ["available", "stale", "conflicting", "unverified"].includes(r.status)).map((r) => `<li>${esc(r.text)} <span class="cite">[${esc(r.id)}]</span> <span class="status s-${esc(r.status)}">${esc(r.status)}</span></li>`).join("") + `</ul>`);

  out.push(`<h2>4. Scenario comparison</h2><table><tr><th>Scenario</th><th>Readiness</th><th>Units</th><th>Gross sq ft</th><th>Parking</th><th>Fits on lot</th><th>Known cost subtotal</th><th>Total dev. cost</th><th>NOI</th><th>Yield on cost</th><th>Spread vs cap</th></tr>`);
  for (const s of b.scenarios || []) out.push(`<tr><td>${esc(s.label)}<div class="fine">${esc(s.differsBy || "")}</div></td><td>${esc(s.readiness.category)}</td><td>${esc(num(s.outputs.units))}</td><td>${esc(num(s.outputs.grossSqft))}</td><td>${esc(num(s.outputs.parkingSpaces))}</td><td>${s.outputs.surfaceParkingFits == null ? "null" : s.outputs.surfaceParkingFits ? "yes" : "no"}</td><td>${esc(money(s.outputs.knownCostSubtotal))}</td><td>${esc(money(s.outputs.totalDevelopmentCost))}</td><td>${esc(money(s.outputs.noi))}</td><td>${esc(pct(s.outputs.yieldOnCost))}</td><td>${esc(pct(s.outputs.spread))}</td></tr>`);
  out.push(`</table><p class="fine">Known cost subtotal is not total development cost. Yield on cost is null until every cost category and income input is declared. Formulas: ${esc(primary ? primary.formulaVersion : "")}.</p>`);
  if (b.reasoning && b.reasoning.output && b.reasoning.output.scenario_comparison.length) out.push(`<div class="model"><ul>` + b.reasoning.output.scenario_comparison.map((s) => `<li><strong>${esc(s.scenario_id)}</strong>: ${esc(s.fit)}. ${esc(s.rationale)} <span class="cite">[${[...s.evidence_ids, ...s.assumption_ids].map(esc).join(", ")}]</span></li>`).join("") + `</ul><p class="fine">${esc(modelLabel)}.</p></div>`);
  for (const s of b.scenarios || []) if (s.uncertainties && s.uncertainties.length) out.push(`<p class="fine"><strong>${esc(s.label)}:</strong> ${s.uncertainties.map(esc).join(" ")}</p>`);

  out.push(`<h2>5. Decisive unknowns and conflicting evidence</h2>`);
  if (b.reasoning && b.reasoning.output && b.reasoning.output.decisive_unknowns.length) out.push(`<div class="model"><ol>` + b.reasoning.output.decisive_unknowns.map((u) => `<li><strong>${esc(u.impact)}</strong>: ${esc(u.statement)} <span class="fine">${esc(u.why)}</span>${u.unknown_id ? ` <span class="cite">[${esc(u.unknown_id)}]</span>` : ""}</li>`).join("") + `</ol><p class="fine">${esc(modelLabel)}.</p></div>`);
  out.push(`<h3>Unknowns recorded by the evidence step</h3><ul>` + (b.unknowns || []).map((u) => `<li><strong>${esc(u.impact)}</strong> · ${esc(u.applicability)}: ${esc(u.statement)} <span class="cite">[${esc(u.id)}]</span></li>`).join("") + `</ul>`);
  const conflicts = [...(b.conflicts || []), ...((b.reasoning && b.reasoning.output && b.reasoning.output.conflicts) || []).map((c) => ({ statement: c.statement, evidenceIds: c.evidence_ids, model: true }))];
  out.push(`<h3>Conflicts</h3>` + (conflicts.length ? `<ul>` + conflicts.map((c) => `<li>${esc(c.statement)} <span class="cite">[${(c.evidenceIds || []).map(esc).join(", ")}]</span>${c.model ? ` <span class="tag">${esc(basis)}</span>` : ""}</li>`).join("") + `</ul>` : `<p class="fine">No conflicting records were detected among the sources read.</p>`));

  out.push(`<h2>6. Prioritized diligence plan</h2><ol>` + plan.map((p) => `<li><strong>${esc(p.lib.text)}</strong> <span class="tag">${esc(p.impact)}</span><div>${esc(p.verification_method)}</div><div class="fine">${esc(p.rationale)}${p.lib.source ? " · Source: " + esc(p.lib.source) : ""} · <code>${esc(p.question_id)}</code> · ranked by ${esc(p.basis)}</div></li>`).join("") + `</ol>`);

  out.push(`<h2>7. Assumptions and sensitivity</h2><table><tr><th>Assumption</th><th>Value</th><th>Basis</th></tr>` + (b.assumptions || []).map((a) => `<tr><td>${esc(a.label)} <code>${esc(a.id)}</code></td><td>${a.value == null ? "null" : esc(num(a.value, 4)) + " " + esc(a.units || "")}</td><td>${esc(a.basis)}</td></tr>`).join("") + `</table>`);
  if (primary && primary.sensitivity && primary.sensitivity.length) out.push(`<table><tr><th>Change</th><th>Units</th><th>Gross sq ft</th><th>Parking fits</th><th>Known cost subtotal</th><th>NOI</th><th>Yield on cost</th><th>Readiness changed</th></tr>` + primary.sensitivity.map((s) => `<tr><td>${esc(s.key)} ${esc(s.change)}</td><td>${esc(num(s.outputs.units))}</td><td>${esc(num(s.outputs.grossSqft))}</td><td>${s.outputs.surfaceParkingFits == null ? "null" : s.outputs.surfaceParkingFits ? "yes" : "no"}</td><td>${esc(money(s.outputs.knownCostSubtotal))}</td><td>${esc(money(s.outputs.noi))}</td><td>${esc(pct(s.outputs.yieldOnCost))}</td><td>${s.readinessChanged ? "yes" : "no"}</td></tr>`).join("") + `</table>`);
  if (b.reasoning && b.reasoning.output && b.reasoning.output.assumption_sensitivity.length) out.push(`<div class="model"><ul>` + b.reasoning.output.assumption_sensitivity.map((s) => `<li><code>${esc(s.assumption_id)}</code> ${esc(s.effect)} <span class="tag">${esc(s.direction)}</span></li>`).join("") + `</ul><p class="fine">${esc(modelLabel)}.</p></div>`);

  out.push(`<h2>8. Citations and source dates</h2><table><tr><th>Id</th><th>Fact</th><th>Scope</th><th>Status</th><th>Source</th><th>Vintage / retrieved</th></tr>` + (b.evidence || []).map(evidenceRow).join("") + `</table>`);

  out.push(`<h2>9. Limitations and scope</h2><ul>` + (b.limitations || []).map((l) => `<li>${esc(l)}</li>`).join("") + ((b.reasoning && b.reasoning.output && b.reasoning.output.limitations) || []).map((l) => `<li>${esc(l)} <span class="tag">${esc(basis)}</span></li>`).join("") + `</ul>`);

  const r = b.run || {};
  out.push(`<h2>10. Run metadata</h2><dl><dt>Brief</dt><dd>${esc(b.id)} version ${esc(b.version)}, schema ${esc(b.schema)}, agent ${esc(b.agentVersion)}</dd><dt>Created / updated</dt><dd>${esc(date(b.createdAt))} / ${esc(date(b.updatedAt))}</dd><dt>Stages</dt><dd>${(r.stages || []).map((s) => esc(s.name + " " + s.status + " " + (s.ms != null ? s.ms + " ms" : ""))).join(" · ")}</dd><dt>Inference</dt><dd>${esc(r.inference ? r.inference.mode + " · " + r.inference.outcome : "not run")}${r.inference && r.inference.reasons && r.inference.reasons.length ? `<div class="fine">${r.inference.reasons.map(esc).join("; ")}</div>` : ""}</dd>${model ? `<dt>Model</dt><dd>${esc(model.provider)} · requested ${esc(model.requestedModel)} · returned ${esc(model.returnedModel || "n/a")} · request ${esc(model.requestId || "n/a")} · ${esc(model.latencyMs != null ? model.latencyMs + " ms" : "")} · attempts ${esc(model.attempts)}</dd><dt>Usage</dt><dd>${model.usage ? esc(num(model.usage.inputTokens)) + " in / " + esc(num(model.usage.outputTokens)) + " out tokens" : "not reported"}</dd><dt>Cost estimate</dt><dd>${model.costEstimate && model.costEstimate.usd != null ? "$" + esc(model.costEstimate.usd.toFixed(6)) + " (list-price estimate as of " + esc(model.costEstimate.pricing.asOf) + ", not a billed amount)" : "not estimated"}</dd>` : ""}<dt>Packet</dt><dd>sha256 ${esc(r.packetHash || "n/a")} · ${esc(r.packetBytes != null ? r.packetBytes + " bytes" : "")}</dd><dt>Evidence hash</dt><dd>${esc(r.evidenceHash || "n/a")}</dd>${b.reasoning && b.reasoning.rejected && b.reasoning.rejected.length ? `<dt>Rejected by the validator</dt><dd>${b.reasoning.rejected.map((x) => esc(x.path + ": " + x.reason + (x.detail ? " (" + x.detail + ")" : ""))).join("<br>")}</dd>` : ""}</dl>`);
  out.push(`<p class="fine">Exported by Cividian. Print this page to PDF for a fixed copy. The JSON export is the same object.</p></div></body></html>`);
  return out.join("\n");
}
