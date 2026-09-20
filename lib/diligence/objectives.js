// lib/diligence/objectives.js
// The bounded vocabulary of the Site Diligence Agent: the development
// objectives it can screen, the labeled assumptions each one needs, the
// evidence each one requires before it can say anything site-specific, and the
// curated diligence question library the model may prioritize but never
// rewrite. Everything the model can reference is declared here as data with a
// stable id, so a citation is either one of these ids or it is rejected.
//
// Nothing here is a market figure. Every default is a screening convention
// that the user is told is an assumption; unit rents, costs, land prices, and
// cap rates have no default because a default would be an invented number.

export const OBJECTIVES = [
  {
    id: "residential_infill",
    label: "Residential infill",
    description: "New multifamily or townhome construction on the parcel, with surface parking on the remaining lot area.",
  },
  {
    id: "mixed_use",
    label: "Mixed-use",
    description: "Ground-floor retail with residential above, surface parking on the remaining lot area.",
  },
  {
    id: "adaptive_reuse",
    label: "Adaptive reuse",
    description: "Conversion of the existing building on the parcel to residential or live-work use without new footprint.",
  },
];

export function objectiveById(id) {
  return OBJECTIVES.find((o) => o.id === id) || null;
}

// Assumption definitions. `value: null` means the user must supply it; the
// engine leaves every dependent output null until they do. `required` marks
// inputs without which even the physical program cannot be screened.
const COMMON = [
  { key: "coveragePct", label: "Lot coverage by building footprint", units: "%", value: 55, min: 5, max: 100, kind: "physical" },
  { key: "floors", label: "Floors", units: "floors", value: 3, min: 1, max: 12, integer: true, kind: "physical" },
  { key: "efficiencyPct", label: "Net-to-gross efficiency", units: "%", value: 82, min: 40, max: 95, kind: "physical" },
  { key: "unitSqft", label: "Average unit size", units: "sq ft", value: 850, min: 300, max: 3000, kind: "physical" },
  { key: "parkingPerUnit", label: "Parking spaces per unit", units: "spaces/unit", value: 1, min: 0, max: 3, kind: "physical" },
  { key: "parkingSqftPerSpace", label: "Surface parking area per space, including aisles", units: "sq ft/space", value: 325, min: 200, max: 450, kind: "physical" },
  { key: "lotSqftOverride", label: "Lot area, if no parcel record is available", units: "sq ft", value: null, min: 500, max: 50000000, kind: "physical" },
  { key: "hardCostPerSqft", label: "Hard construction cost", units: "$/gross sq ft", value: null, min: 20, max: 2000, kind: "financial" },
  { key: "softPctOfHard", label: "Soft costs as a share of hard cost", units: "%", value: 20, min: 0, max: 60, kind: "financial" },
  { key: "landPrice", label: "Land or acquisition price", units: "$", value: null, min: 0, max: 1000000000, kind: "financial" },
  { key: "rentPerSqftMonth", label: "Residential rent", units: "$/sq ft/month", value: null, min: 0.25, max: 15, kind: "financial" },
  { key: "vacancyPct", label: "Vacancy and credit loss", units: "%", value: 7, min: 0, max: 30, kind: "financial" },
  { key: "otherAnnualIncome", label: "Other annual income (an explicit zero unless entered)", units: "$/year", value: 0, min: 0, max: 100000000, kind: "financial" },
  { key: "opexPctOfEgi", label: "Operating expenses as a share of effective gross income", units: "%", value: 40, min: 10, max: 70, kind: "financial" },
  { key: "capRatePct", label: "Exit or market cap rate", units: "%", value: null, min: 3, max: 15, kind: "financial" },
];

export const ASSUMPTION_DEFAULTS = {
  residential_infill: COMMON,
  mixed_use: [
    ...COMMON.map((a) => (a.key === "coveragePct" ? { ...a, value: 60 } : a.key === "floors" ? { ...a, value: 4 } : a)),
    { key: "groundRetailPct", label: "Ground floor share used for retail", units: "%", value: 60, min: 0, max: 100, kind: "physical" },
    { key: "retailParkingSqftPerSpace", label: "Retail net area per required parking space", units: "sq ft/space", value: 300, min: 150, max: 1000, kind: "physical" },
    { key: "retailRentPerSqftYear", label: "Retail rent", units: "$/net sq ft/year", value: null, min: 2, max: 150, kind: "financial" },
  ],
  adaptive_reuse: [
    ...COMMON.filter((a) => !["coveragePct", "floors"].includes(a.key)).map((a) =>
      a.key === "efficiencyPct" ? { ...a, value: 75 } : a.key === "hardCostPerSqft" ? { ...a, label: "Renovation cost", units: "$/gross sq ft" } : a),
    { key: "existingBldgSqft", label: "Existing building gross area, if the parcel record has none", units: "sq ft", value: null, min: 200, max: 5000000, kind: "physical" },
    { key: "existingFloors", label: "Existing floors", units: "floors", value: 2, min: 1, max: 30, integer: true, kind: "physical" },
  ],
};

// Coerce user assumptions into labeled, clamped values. A value the user did
// not send keeps the default and is labeled default_assumption; a value the
// user sent is user_assumption; a null stays null and is labeled not_provided.
// Out-of-range numbers are refused rather than clamped silently, because a
// clamped input is a number the user did not type.
export function normalizeAssumptions(objectiveId, raw) {
  const defs = ASSUMPTION_DEFAULTS[objectiveId];
  if (!defs) return { ok: false, error: "unknown_objective", assumptions: [] };
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const known = new Set(defs.map((d) => d.key));
  for (const key of Object.keys(input)) if (!known.has(key)) errors.push({ key, error: "unknown_assumption" });
  const assumptions = defs.map((d) => {
    const has = Object.prototype.hasOwnProperty.call(input, d.key);
    let value = d.value;
    let basis = "default_assumption";
    if (has) {
      const v = input[d.key];
      if (v === null || v === "" || v === undefined) { value = null; basis = "not_provided"; }
      else if (typeof v === "boolean" || (typeof v !== "number" && typeof v !== "string") || !Number.isFinite(Number(v))) {
        errors.push({ key: d.key, error: "not_a_number" }); value = d.value; basis = value == null ? "not_provided" : "default_assumption";
      } else {
        const n = Number(v);
        if (n < d.min || n > d.max) { errors.push({ key: d.key, error: "out_of_range", min: d.min, max: d.max }); value = d.value; basis = value == null ? "not_provided" : "default_assumption"; }
        else { value = d.integer ? Math.round(n) : Math.round(n * 10000) / 10000; basis = "user_assumption"; }
      }
    } else if (value == null) basis = "not_provided";
    return { id: "as_" + d.key, key: d.key, label: d.label, units: d.units, value, basis, kind: d.kind, min: d.min, max: d.max };
  });
  return { ok: errors.length === 0, errors, assumptions };
}

// Evidence keys an objective needs before the agent can speak site-specifically.
// `site` keys are parcel or point scoped; `context` keys are city or county.
export const REQUIRED_EVIDENCE = {
  residential_infill: {
    site: ["site_point", "parcel_identity", "parcel_lot_area", "zoning_envelope"],
    context: ["city_population", "city_median_income", "city_median_home_value", "city_vacancy_pct", "county_gaps"],
  },
  mixed_use: {
    site: ["site_point", "parcel_identity", "parcel_lot_area", "zoning_envelope"],
    context: ["city_population", "city_median_income", "city_median_home_value", "city_vacancy_pct", "county_gaps"],
  },
  adaptive_reuse: {
    site: ["site_point", "parcel_identity", "parcel_lot_area", "parcel_building_sqft", "parcel_year_built", "zoning_envelope"],
    context: ["city_population", "city_median_income", "city_median_home_value", "city_vacancy_pct", "county_gaps"],
  },
};

// The diligence question library. `satisfiedBy` names the evidence keys whose
// availability answers the question; `trigger` says when the baseline plan
// raises it: when those keys are missing, always, or only for stale evidence.
export const QUESTIONS = [
  { id: "q_zoning_district", text: "Which zoning district governs the parcel, and is the proposed use permitted by right, conditionally, or not at all?", area: "entitlement", impact: "high", method: "Read the adopted zoning map and ordinance text for the parcel; confirm with the planning department in writing.", source: "Municipal planning or zoning office; adopted zoning ordinance.", objectives: ["all"], satisfiedBy: ["zoning_envelope"], trigger: "missing" },
  { id: "q_zoning_dimensional", text: "What height, setback, density, lot coverage, and parking minimums apply, and does the scenario massing fit inside them?", area: "entitlement", impact: "high", method: "Compare the ordinance dimensional table against the scenario footprint, floors, and parking count.", source: "Adopted zoning ordinance; planning staff pre-application meeting.", objectives: ["all"], satisfiedBy: ["zoning_envelope"], trigger: "missing" },
  { id: "q_parcel_boundary", text: "Does a survey confirm the parcel boundary and lot area used in the capacity math?", area: "site", impact: "high", method: "Commission an ALTA or boundary survey; compare the surveyed area with the provider polygon.", source: "Licensed surveyor; recorded plat.", objectives: ["all"], satisfiedBy: ["parcel_lot_area"], trigger: "always" },
  { id: "q_ownership_title", text: "Who holds title, and what liens, easements, or covenants encumber the parcel?", area: "site", impact: "high", method: "Order a title commitment; review recorded easements and restrictions.", source: "Title company; county recorder.", objectives: ["all"], satisfiedBy: [], trigger: "always" },
  { id: "q_existing_structure", text: "What is the size, condition, and age of the existing structure, and what does a condition assessment show?", area: "site", impact: "high", method: "Property condition assessment; measured drawings; review of assessor building records.", source: "Licensed inspector or architect; county assessor.", objectives: ["adaptive_reuse"], satisfiedBy: ["parcel_building_sqft", "parcel_year_built"], trigger: "missing" },
  { id: "q_code_reuse", text: "What building code, accessibility, and fire separation upgrades does a change of use require?", area: "site", impact: "high", method: "Code review by an architect against the adopted building code and change-of-occupancy rules.", source: "Building department; licensed architect.", objectives: ["adaptive_reuse"], satisfiedBy: [], trigger: "always" },
  { id: "q_historic", text: "Is the building or district subject to historic designation or review that constrains exterior changes?", area: "entitlement", impact: "medium", method: "Check local and national register listings; ask the historic preservation commission.", source: "Local historic preservation office; National Register.", objectives: ["adaptive_reuse"], satisfiedBy: [], trigger: "always" },
  { id: "q_utilities", text: "Do water, sewer, electric, and gas have capacity for the proposed program, and what are the connection costs?", area: "infrastructure", impact: "high", method: "Request will-serve letters and capacity confirmation from each utility.", source: "Municipal utilities; electric and gas providers.", objectives: ["all"], satisfiedBy: [], trigger: "always" },
  { id: "q_environmental", text: "What do a Phase I environmental site assessment, floodplain determination, and soils information show for the parcel?", area: "site", impact: "high", method: "Commission a Phase I ESA; check the FEMA flood map; review soils and any geotechnical borings.", source: "Environmental consultant; FEMA Flood Map Service Center.", objectives: ["all"], satisfiedBy: [], trigger: "always" },
  { id: "q_market_rents", text: "What rents, absorption, and concessions are achievable for this program in this submarket today?", area: "market", impact: "high", method: "Collect current rent comparables and lease-up history from local brokers and operators.", source: "Local brokers; property managers; recent lease comparables.", objectives: ["all"], satisfiedBy: ["market_rent"], trigger: "missing" },
  { id: "q_construction_cost", text: "What hard and soft costs does a contractor or estimator support for this program and site?", area: "cost", impact: "high", method: "Obtain a conceptual estimate from a general contractor or cost estimator on the scenario program.", source: "General contractor; cost estimator.", objectives: ["all"], satisfiedBy: ["construction_cost"], trigger: "missing" },
  { id: "q_land_price", text: "What acquisition price and terms does the seller support, and how does that compare with an appraisal?", area: "cost", impact: "medium", method: "Obtain an asking price or letter of intent terms; commission an appraisal if warranted.", source: "Seller or listing broker; licensed appraiser.", objectives: ["all"], satisfiedBy: ["land_price"], trigger: "missing" },
  { id: "q_cap_rate", text: "What exit or market cap rate do recent sales of comparable assets support?", area: "market", impact: "medium", method: "Review recent comparable sales and investor surveys for the asset class and submarket.", source: "Investment sales brokers; recorded transactions.", objectives: ["all"], satisfiedBy: ["cap_rate"], trigger: "missing" },
  { id: "q_parking", text: "Can the required parking fit on the site, or will structured parking, shared parking, or a variance be needed?", area: "entitlement", impact: "medium", method: "Compare the ordinance parking minimum with the scenario surface parking area and the remaining lot.", source: "Zoning ordinance; site plan test fit.", objectives: ["residential_infill", "mixed_use"], satisfiedBy: ["zoning_envelope"], trigger: "always" },
  { id: "q_incentives", text: "Which incentive programs, if any, apply to this parcel, and what would the council or redevelopment commission need to approve?", area: "finance", impact: "medium", method: "Ask the economic development office; read recent council and redevelopment commission minutes. Never assume availability.", source: "Economic development office; council records.", objectives: ["all"], satisfiedBy: [], trigger: "always" },
  { id: "q_demand", text: "What current local evidence, beyond the Census vintage, supports demand for this program?", area: "market", impact: "medium", method: "Review recent permits, absorption, employer announcements, and vacancy reports for the submarket.", source: "Building department permit logs; local economic development reports.", objectives: ["all"], satisfiedBy: ["city_population", "city_vacancy_pct"], trigger: "stale" },
  { id: "q_access", text: "What street access, curb cuts, and transportation constraints apply to the frontage?", area: "infrastructure", impact: "medium", method: "Confirm access permits with the street authority; review any corridor plans.", source: "Municipal engineering; state DOT if a state route.", objectives: ["all"], satisfiedBy: [], trigger: "always" },
  { id: "q_neighbors", text: "What are the adjacent uses, and how compatible is the proposed program with them?", area: "site", impact: "low", method: "Site visit; adjacent parcel use records; neighborhood plan review.", source: "Site visit; county assessor records.", objectives: ["all"], satisfiedBy: [], trigger: "always" },
  { id: "q_county_scope", text: "Do county-level business pattern gaps hold for this parcel's actual trade area?", area: "market", impact: "low", method: "Define a trade area and compare it with the county-level ratios before relying on them.", source: "Trade-area analysis; local business inventory.", objectives: ["all"], satisfiedBy: ["county_gaps"], trigger: "always" },
  { id: "q_census_vintage", text: "How have population, income, home values, and vacancy moved since the Census vintage in this brief?", area: "market", impact: "medium", method: "Compare the ACS vintage with the newest available estimates and local indicators.", source: "US Census ACS newer vintage; local sources.", objectives: ["all"], satisfiedBy: ["city_population", "city_median_income", "city_median_home_value", "city_vacancy_pct"], trigger: "stale" },
  { id: "q_city_context", text: "What are the city's fundamentals, since no Census read resolved for this brief?", area: "market", impact: "medium", method: "Obtain the ACS profile for the place directly from the Census, or configure a Census key.", source: "US Census ACS 5-year.", objectives: ["all"], satisfiedBy: ["city_population", "city_median_income", "city_median_home_value", "city_vacancy_pct"], trigger: "missing" },
];

export function questionById(id) {
  return QUESTIONS.find((q) => q.id === id) || null;
}

export function questionsFor(objectiveId) {
  return QUESTIONS.filter((q) => q.objectives.includes("all") || q.objectives.includes(objectiveId));
}
