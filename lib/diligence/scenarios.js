// lib/diligence/scenarios.js
// Deterministic development scenarios for one site and objective. The
// physical program is arithmetic over labeled inputs; the financial screen is
// the Studio engine (studio.screening.v1), reused so this brief and the
// Development Studio can never disagree about the same assumptions.
//
// Rules held here: an input is either a cited evidence value or a labeled
// assumption; a missing input yields a null output and a named uncertainty; a
// known cost subtotal is never a total development cost; yield on cost is null
// until the cost basis is complete; and the readiness category follows the
// published criteria in docs/hackathon/ARCHITECTURE.md.

import { REQUIRED_EVIDENCE } from "./objectives.js";

const M2_PER_SQFT = 0.09290304;
export const SCENARIO_SCHEMA = "scenario.v1";
export const FORMULA_VERSION = "diligence-capacity.v1 + studio.screening.v1";

let financeEngine = null;
async function loadFinance(deps) {
  if (deps && deps.finance) return deps.finance;
  if (financeEngine) return financeEngine;
  try {
    financeEngine = await import("../../studio-runtime/studio/finance.js");
  } catch {
    financeEngine = null;
  }
  return financeEngine;
}

function val(assumptions, key) {
  const a = assumptions.find((x) => x.key === key);
  return a && a.value != null ? a.value : null;
}
function ref(assumptions, key) {
  const a = assumptions.find((x) => x.key === key);
  return a ? { key, value: a.value, basis: a.basis, assumptionId: a.id, label: a.label, units: a.units } : { key, value: null, basis: "not_provided", assumptionId: null };
}
const round = (n, d = 0) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// Physical program. Every branch records the inputs it consumed and a formula
// string so the arithmetic can be audited without reading this file.
function program(objective, variant, lotSqft, lotInput, assumptions, evidence) {
  const inputs = [lotInput];
  const formulas = {};
  const out = { footprintSqft: null, grossSqft: null, netSqft: null, units: null, retailNetSqft: null, parkingSpaces: null, parkingAreaSqft: null, siteUsedSqft: null, surfaceParkingFits: null, newFootprint: true };
  const uncertainties = [];
  if (lotSqft == null) return { inputs, formulas, outputs: out, uncertainties: ["Lot area is unknown, so no physical program can be screened."] };

  const eff = ref(assumptions, "efficiencyPct"), unit = ref(assumptions, "unitSqft"), ppu = ref(assumptions, "parkingPerUnit"), pspace = ref(assumptions, "parkingSqftPerSpace");
  inputs.push(eff, unit, ppu, pspace);

  if (objective === "adaptive_reuse" && variant === "primary") {
    const bldg = evidence.find((r) => r.key === "parcel_building_sqft" && r.value != null);
    const bldgA = ref(assumptions, "existingBldgSqft");
    const floors = ref(assumptions, "existingFloors");
    inputs.push(floors);
    let gsf = null;
    if (bldg) { inputs.push({ key: "existingBldgSqft", value: bldg.value, basis: "source_observed", evidenceId: bldg.id, label: "Existing building area", units: "sq ft" }); gsf = bldg.value; }
    else if (bldgA.value != null) { inputs.push(bldgA); gsf = bldgA.value; }
    else { inputs.push(bldgA); uncertainties.push("Existing building area is unknown from the parcel record and was not entered, so the reuse program cannot be sized."); }
    out.newFootprint = false;
    if (gsf != null) {
      out.grossSqft = round(gsf);
      out.footprintSqft = floors.value ? round(gsf / floors.value) : null;
      out.netSqft = round(gsf * eff.value / 100);
      out.units = Math.floor(out.netSqft / unit.value);
      out.parkingSpaces = Math.ceil(out.units * ppu.value);
      out.parkingAreaSqft = round(out.parkingSpaces * pspace.value);
      out.siteUsedSqft = out.footprintSqft != null ? round(out.footprintSqft + out.parkingAreaSqft) : null;
      out.surfaceParkingFits = out.siteUsedSqft != null ? out.siteUsedSqft <= lotSqft : null;
      Object.assign(formulas, { grossSqft: "existing building gross area", footprintSqft: "grossSqft / existingFloors", netSqft: "grossSqft x efficiency", units: "floor(netSqft / unitSqft)", parkingSpaces: "ceil(units x parkingPerUnit)", parkingAreaSqft: "parkingSpaces x parkingSqftPerSpace", surfaceParkingFits: "footprintSqft + parkingAreaSqft <= lotSqft" });
    }
    return { inputs, formulas, outputs: out, uncertainties };
  }

  const cover = ref(assumptions, "coveragePct"), floors = ref(assumptions, "floors");
  inputs.push(cover, floors);
  const footprint = lotSqft * cover.value / 100;
  const gsf = footprint * floors.value;
  let residentialGsf = gsf, retailNsf = 0;
  if (objective === "mixed_use" && variant === "primary") {
    const retail = ref(assumptions, "groundRetailPct"), rps = ref(assumptions, "retailParkingSqftPerSpace");
    inputs.push(retail, rps);
    const retailGsf = footprint * retail.value / 100;
    retailNsf = retailGsf * eff.value / 100;
    residentialGsf = gsf - retailGsf;
    out.retailNetSqft = round(retailNsf);
    formulas.retailNetSqft = "footprint x groundRetailPct x efficiency";
    formulas.retailParkingSpaces = "ceil(retailNetSqft / retailParkingSqftPerSpace)";
    out.retailParkingSpaces = Math.ceil(retailNsf / rps.value);
  }
  const nsf = residentialGsf * eff.value / 100;
  out.footprintSqft = round(footprint);
  out.grossSqft = round(gsf);
  out.netSqft = round(nsf);
  out.units = Math.floor(nsf / unit.value);
  out.parkingSpaces = Math.ceil(out.units * ppu.value) + (out.retailParkingSpaces || 0);
  out.parkingAreaSqft = round(out.parkingSpaces * pspace.value);
  out.siteUsedSqft = round(footprint + out.parkingAreaSqft);
  out.surfaceParkingFits = out.siteUsedSqft <= lotSqft;
  Object.assign(formulas, { footprintSqft: "lotSqft x coveragePct", grossSqft: "footprintSqft x floors", netSqft: "(grossSqft - retailGrossSqft) x efficiency", units: "floor(netSqft / unitSqft)", parkingSpaces: "ceil(units x parkingPerUnit) + retailParkingSpaces", parkingAreaSqft: "parkingSpaces x parkingSqftPerSpace", surfaceParkingFits: "footprintSqft + parkingAreaSqft <= lotSqft" });
  if (!out.surfaceParkingFits) uncertainties.push("Surface parking for this program does not fit beside the footprint on the lot; structured parking, shared parking, or a smaller program would be needed.");
  return { inputs, formulas, outputs: out, uncertainties };
}

// The Studio engine, given the program. Mirrors experience/feasibility.ts so
// the legacy Feasibility tab, Studio, and this brief share one arithmetic.
async function screen(engine, objective, prog, assumptions, scenarioId) {
  const notes = [];
  const outputs = { hardCostSubtotal: null, softCostSubtotal: null, knownCostSubtotal: null, totalDevelopmentCost: null, potentialGrossIncome: null, effectiveGrossIncome: null, noi: null, yieldOnCost: null, capRate: null, spread: null, missingCostCategories: [], missingIncomeInputs: [] };
  const inputs = [];
  if (!engine) return { outputs, inputs, notes: ["The Studio finance runtime is not built on this host, so the financial screen did not run. Physical quantities are unaffected."], available: false };
  if (prog.outputs.grossSqft == null) return { outputs, inputs, notes: ["No program, so no financial screen."], available: true };
  const hard = ref(assumptions, "hardCostPerSqft"), soft = ref(assumptions, "softPctOfHard"), land = ref(assumptions, "landPrice"), rent = ref(assumptions, "rentPerSqftMonth"), vac = ref(assumptions, "vacancyPct"), opex = ref(assumptions, "opexPctOfEgi"), cap = ref(assumptions, "capRatePct"), unit = ref(assumptions, "unitSqft"), other = ref(assumptions, "otherAnnualIncome");
  inputs.push(hard, soft, land, rent, vac, opex, cap, other);
  const retailRent = objective === "mixed_use" ? ref(assumptions, "retailRentPerSqftYear") : null;
  if (retailRent) inputs.push(retailRent);
  const gsf = prog.outputs.grossSqft;
  const f = engine.blankFinance("diligence-" + scenarioId);
  f.sourceNote = "Labeled screening assumptions from the Site Diligence Agent. Not verified figures.";
  const hardCents = hard.value != null ? Math.round(hard.value * 100) : null;
  f.costs = engine.COST_CATEGORIES.map((category) => {
    if (category === "hard_construction") return { category, method: "gross_area_rate", centsPerSqft: hardCents };
    if (category === "soft_costs") return hardCents == null ? { category, method: "unknown" } : { category, method: "amount", cents: Math.round(Math.round(gsf * hardCents) * soft.value / 100) };
    if (category === "acquisition") return land.value == null ? { category, method: "unknown" } : { category, method: "amount", cents: Math.round(land.value * 100) };
    return { category, method: "unknown" };
  });
  f.income.unitCount = prog.outputs.units || 0;
  f.income.residentialMonthlyRentCents = rent.value == null ? null : Math.round(unit.value * rent.value * 100);
  f.income.retailAnnualRentPerNetSqftCents = retailRent && retailRent.value != null ? Math.round(retailRent.value * 100) : null;
  f.income.vacancyBps = Math.round(vac.value * 100);
  f.income.otherAnnualIncomeCents = other.value == null ? null : Math.round(other.value * 100);
  const context = { scenarioId, versionId: "v1", site: { id: "diligence-site", projectId: null }, assumptions: { id: "diligence-assumptions", efficiency: val(assumptions, "efficiencyPct") / 100 }, finance: f };
  const quantities = { scenarioId, scenarioVersionId: "v1", assumptionVersionId: "diligence-assumptions", proposedGrossAreaM2: gsf * M2_PER_SQFT, estimatedUnits: prog.outputs.units || 0, areaByUseM2: { residential: (gsf - (prog.outputs.retailNetSqft || 0) / (val(assumptions, "efficiencyPct") / 100)) * M2_PER_SQFT, retail: ((prog.outputs.retailNetSqft || 0) / (val(assumptions, "efficiencyPct") / 100)) * M2_PER_SQFT, office: 0 } };
  let result;
  try {
    const interim = engine.calculateFinance(context, quantities);
    f.income.operatingExpensesAnnualCents = interim.effectiveGrossIncomeCents == null ? null : Math.round(interim.effectiveGrossIncomeCents * opex.value / 100);
    result = engine.calculateFinance(context, quantities);
  } catch (e) {
    return { outputs, inputs, notes: ["The financial screen refused these inputs: " + String((e && e.message) || e)], available: true };
  }
  const dollars = (c) => (c == null ? null : round(c / 100));
  const hardLine = result.costLines.find((l) => l.category === "hard_construction");
  const softLine = result.costLines.find((l) => l.category === "soft_costs");
  outputs.hardCostSubtotal = dollars(hardLine ? hardLine.cents : null);
  outputs.softCostSubtotal = dollars(softLine ? softLine.cents : null);
  outputs.knownCostSubtotal = dollars(result.knownCostSubtotalCents);
  outputs.totalDevelopmentCost = dollars(result.totalDevelopmentCostCents);
  outputs.potentialGrossIncome = dollars(result.potentialGrossIncomeCents);
  outputs.effectiveGrossIncome = dollars(result.effectiveGrossIncomeCents);
  outputs.noi = dollars(result.noiCents);
  outputs.yieldOnCost = result.yieldOnCost == null ? null : round(result.yieldOnCost, 4);
  outputs.capRate = cap.value == null ? null : cap.value / 100;
  outputs.spread = outputs.yieldOnCost == null || outputs.capRate == null ? null : round(outputs.yieldOnCost - outputs.capRate, 4);
  outputs.missingCostCategories = result.missingCostCategories;
  outputs.missingIncomeInputs = result.missingIncomeInputs;
  notes.push(...result.notes);
  if (outputs.totalDevelopmentCost == null) notes.push("Total development cost is null because " + (result.missingCostCategories.length ? result.missingCostCategories.length + " cost categories are unknown (" + result.missingCostCategories.join(", ") + ")" : "the cost basis is incomplete") + ". The known subtotal is not a total.");
  return { outputs, inputs, notes, available: true, formulaVersion: result.formulaVersion };
}

export function readiness(lotSqft, prog, fin) {
  if (lotSqft == null || prog.outputs.grossSqft == null) return { category: "not_screenable", criteria: ["No lot area (parcel record or labeled entry), so no physical program can be screened."] };
  const missing = [];
  if (!fin.available) missing.push("finance engine unavailable on this host");
  if (fin.outputs.totalDevelopmentCost == null) missing.push("cost basis incomplete (" + (fin.outputs.missingCostCategories || []).join(", ") + ")");
  if (fin.outputs.noi == null) missing.push("income inputs incomplete (" + (fin.outputs.missingIncomeInputs || []).join(", ") + ")");
  if (fin.outputs.capRate == null) missing.push("no cap rate assumption");
  if (missing.length) return { category: "incomplete", criteria: ["Physical program computed from labeled inputs.", "Financial screen incomplete: " + missing.join("; ") + "."] };
  return { category: "screenable", criteria: ["Physical program computed from labeled inputs.", "Every financial output computed from labeled assumptions. These are screening assumptions, not verified figures."] };
}

export function coverage(objective, evidence) {
  const req = REQUIRED_EVIDENCE[objective] || REQUIRED_EVIDENCE.residential_infill;
  const has = (k) => evidence.some((r) => r.key === k && (r.status === "available" || r.status === "stale" || r.status === "conflicting"));
  const site = req.site.filter(has).length, context = req.context.filter(has).length;
  const ratio = (site + context) / (req.site.length + req.context.length);
  return {
    siteAvailable: site, siteRequired: req.site.length, contextAvailable: context, contextRequired: req.context.length,
    missing: [...req.site.filter((k) => !has(k)), ...req.context.filter((k) => !has(k))],
    category: ratio >= 0.75 ? "substantial" : ratio >= 0.4 ? "partial" : "thin",
    criteria: "substantial: 75% or more of required keys available; partial: 40% to 74%; thin: below 40%.",
  };
}

async function buildOne(engine, objective, variant, label, differsBy, assumptions, evidence, lot) {
  const id = "scn_" + objective + (variant === "primary" ? "" : "_" + variant);
  const prog = program(objective, variant, lot.value, lot.input, assumptions, evidence);
  const fin = await screen(engine, objective, prog, assumptions, id);
  return {
    schema: SCENARIO_SCHEMA,
    id,
    objective,
    variant,
    label,
    differsBy: differsBy || null,
    formulaVersion: FORMULA_VERSION,
    inputs: [...prog.inputs, ...fin.inputs],
    outputs: { ...prog.outputs, ...fin.outputs },
    formulas: prog.formulas,
    notes: fin.notes,
    readiness: readiness(lot.value, prog, fin),
    uncertainties: [...prog.uncertainties, ...(fin.outputs.missingCostCategories && fin.outputs.missingCostCategories.length ? ["Cost categories unknown: " + fin.outputs.missingCostCategories.join(", ") + "."] : []), ...(fin.outputs.missingIncomeInputs && fin.outputs.missingIncomeInputs.length ? ["Income inputs missing: " + fin.outputs.missingIncomeInputs.join(", ") + "."] : [])],
    dependencies: ["q_zoning_district", "q_zoning_dimensional", "q_parcel_boundary", ...(objective === "adaptive_reuse" ? ["q_existing_structure", "q_code_reuse"] : ["q_parking"]), "q_utilities", "q_market_rents", "q_construction_cost"],
    financeAvailable: fin.available,
  };
}

function lotFrom(evidence, assumptions) {
  const rec = evidence.find((r) => r.key === "parcel_lot_area" && r.value != null && r.status !== "unverified");
  if (rec) return { value: rec.value, input: { key: "lotSqft", value: rec.value, basis: "source_observed", evidenceId: rec.id, label: "Lot area", units: "sq ft" } };
  const unv = evidence.find((r) => r.key === "parcel_lot_area" && r.value != null);
  const o = ref(assumptions, "lotSqftOverride");
  if (o.value != null) return { value: o.value, input: { ...o, label: "Lot area (user entry)" } };
  if (unv) return { value: unv.value, input: { key: "lotSqft", value: unv.value, basis: "source_observed", evidenceId: unv.id, label: "Lot area (unconfirmed parcel match)", units: "sq ft", unverified: true } };
  return { value: null, input: { key: "lotSqft", value: null, basis: "not_provided", label: "Lot area", units: "sq ft" } };
}

// Sensitivity: rerun the primary scenario under bounded changes and report
// what moves. Only assumptions with a value are varied; nothing is invented to
// make a sensitivity row appear.
async function sensitivity(engine, objective, assumptions, evidence, lot, base) {
  const rows = [];
  const variations = [];
  if (val(assumptions, "hardCostPerSqft") != null) variations.push(["hardCostPerSqft", "+20%", 1.2], ["hardCostPerSqft", "-20%", 0.8]);
  if (val(assumptions, "rentPerSqftMonth") != null) variations.push(["rentPerSqftMonth", "+20%", 1.2], ["rentPerSqftMonth", "-20%", 0.8]);
  if (objective !== "adaptive_reuse") variations.push(["floors", "+1 floor", null, 1], ["floors", "-1 floor", null, -1]);
  for (const [key, change, factor, delta] of variations) {
    const alt = assumptions.map((a) => {
      if (a.key !== key) return a;
      const v = factor != null ? a.value * factor : Math.max(1, a.value + delta);
      return { ...a, value: key === "floors" ? Math.round(v) : Math.round(v * 100) / 100, basis: "sensitivity_variation" };
    });
    const prog = program(objective, "primary", lot.value, lot.input, alt, evidence);
    const fin = await screen(engine, objective, prog, alt, base.id + "_sens");
    const r = readiness(lot.value, prog, fin);
    rows.push({
      assumptionId: "as_" + key, key, change,
      outputs: { units: prog.outputs.units, grossSqft: prog.outputs.grossSqft, parkingSpaces: prog.outputs.parkingSpaces, surfaceParkingFits: prog.outputs.surfaceParkingFits, knownCostSubtotal: fin.outputs.knownCostSubtotal, noi: fin.outputs.noi, yieldOnCost: fin.outputs.yieldOnCost, spread: fin.outputs.spread },
      deltas: { units: prog.outputs.units == null || base.outputs.units == null ? null : prog.outputs.units - base.outputs.units, yieldOnCost: fin.outputs.yieldOnCost == null || base.outputs.yieldOnCost == null ? null : round(fin.outputs.yieldOnCost - base.outputs.yieldOnCost, 4) },
      readinessChanged: r.category !== base.readiness.category,
      parkingFitChanged: prog.outputs.surfaceParkingFits !== base.outputs.surfaceParkingFits,
    });
  }
  return rows;
}

export async function computeScenarios({ objective, evidence, assumptions }, deps = {}) {
  const engine = await loadFinance(deps);
  const lot = lotFrom(evidence, assumptions);
  const primaryLabel = { residential_infill: "Residential infill", mixed_use: "Mixed-use", adaptive_reuse: "Adaptive reuse" }[objective] || objective;
  const primary = await buildOne(engine, objective, "primary", primaryLabel, null, assumptions, evidence, lot);
  const comparators = [];
  if (objective === "residential_infill") {
    const alt = assumptions.map((a) => (a.key === "floors" ? { ...a, value: Math.max(1, a.value - 1), basis: "comparator_variation" } : a));
    comparators.push(await buildOne(engine, objective, "lower_density", "Lower-density comparator", "One fewer floor; everything else held equal.", alt, evidence, lot));
  } else if (objective === "mixed_use") {
    comparators.push(await buildOne(engine, "residential_infill", "primary", "Residential-only comparator", "Same massing with no ground-floor retail.", assumptions.map((a) => (a.key === "groundRetailPct" ? { ...a, value: 0, basis: "comparator_variation" } : a)), evidence, lot).then((s) => ({ ...s, id: "scn_mixed_use_residential_only", objective: "mixed_use", variant: "residential_only" })));
  } else if (objective === "adaptive_reuse") {
    const infill = [...assumptions.filter((a) => !["existingBldgSqft", "existingFloors"].includes(a.key)), { id: "as_coveragePct", key: "coveragePct", label: "Lot coverage by building footprint", units: "%", value: 55, basis: "comparator_variation" }, { id: "as_floors", key: "floors", label: "Floors", units: "floors", value: 3, basis: "comparator_variation" }];
    comparators.push(await buildOne(engine, "residential_infill", "primary", "Demolish and rebuild comparator", "New three-floor infill at 55% coverage instead of reuse; demolition cost is unknown and not included.", infill, evidence, lot).then((s) => ({ ...s, id: "scn_adaptive_reuse_rebuild", objective: "adaptive_reuse", variant: "rebuild" })));
  }
  const sens = await sensitivity(engine, objective, assumptions, evidence, lot, primary);
  primary.sensitivity = sens;
  const cov = coverage(objective, evidence);
  primary.coverage = cov;
  for (const c of comparators) { c.sensitivity = []; c.coverage = cov; }
  return { scenarios: [primary, ...comparators], lot, coverage: cov, financeAvailable: !!engine };
}
