// lib/diligence/evidence.js
// Evidence gathering for one site and objective. Every source read becomes an
// evidence.record.v1 row whether it succeeded or not: a source that did not
// answer is an `unavailable` row that names the reason, a dated vintage is a
// `stale` row that stays dated, and two sources that disagree are both marked
// `conflicting` and listed under conflicts. City and county rows are context;
// parcel and point rows are site evidence. The two never blur.
//
// This module never throws and never invents a value. Missing is null.

import { createHash } from "node:crypto";
import { getCity as defaultGetCity } from "../citydata.js";
import { marketGaps as defaultGaps } from "../gaps.js";
import { fetchZoning as defaultZoning } from "../providers.js";
import { REQUIRED_EVIDENCE, questionsFor } from "./objectives.js";

export const EVIDENCE_SCHEMA = "evidence.record.v1";
export const EXTRACTION_VERSIONS = { acs: "acs.v1", parcel: "parcel.v1", zoning: "zoning.v1", gaps: "cbp-gaps.v1", geocode: "geocode.v1", county: "fcc-county.v1", score: "cividian-score.v1" };
const INMAP_URL = "https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0";

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function fmt(value, units) {
  if (value == null) return "not available";
  if (units === "USD") return "$" + Number(value).toLocaleString("en-US");
  if (units === "%") return Number(value).toLocaleString("en-US") + "%";
  if (units === "sq ft") return Number(value).toLocaleString("en-US") + " sq ft";
  return Number(value).toLocaleString("en-US") + (units ? " " + units : "");
}

// The one constructor every row goes through, so no row can miss a field.
export function record(fields) {
  const r = {
    schema: EVIDENCE_SCHEMA,
    id: fields.id,
    kind: fields.kind || "source_observed",
    key: fields.key,
    fact: fields.fact,
    value: fields.value === undefined ? null : fields.value,
    units: fields.units || null,
    text: fields.text,
    source: { name: fields.source.name, url: fields.source.url || null, authority: fields.source.authority, type: fields.source.type || "api_json" },
    scope: { level: fields.scope.level, geoid: fields.scope.geoid || null, parcelId: fields.scope.parcelId || null, label: fields.scope.label },
    applicability: fields.scope.level === "city" || fields.scope.level === "county" ? "context" : "site",
    retrievedAt: fields.retrievedAt || null,
    publishedAt: fields.publishedAt || null,
    vintage: fields.vintage || null,
    freshness: fields.freshness || "unknown",
    extraction: fields.extraction || "api_json",
    extractionVersion: fields.extractionVersion || null,
    status: fields.status || (fields.value == null ? "unavailable" : "available"),
    coverage: fields.coverage || null,
    excerpt: fields.excerpt || null,
    hash: fields.hash || null,
    note: fields.note || null,
  };
  return r;
}

function vintageYear(asOf) {
  const m = /(\d{4})/.exec(String(asOf || ""));
  return m ? Number(m[1]) : null;
}

// Historical vintages stay dated. A vintage three or more calendar years old
// is flagged stale so the reader sees the age before the number.
export function stalenessStatus(asOf, now) {
  const y = vintageYear(asOf);
  if (!y) return "available";
  return now.getFullYear() - y >= 3 ? "stale" : "available";
}

export async function gatherEvidence(site, objectiveId, deps = {}) {
  const getCity = deps.getCity || defaultGetCity;
  const gaps = deps.gaps || defaultGaps;
  const zoning = deps.zoning || defaultZoning;
  const now = deps.now ? deps.now() : new Date();
  const at = now.toISOString();
  const evidence = [];
  const conflicts = [];
  const sources = {};
  const placeLabel = site.city && site.state ? site.city + ", " + site.state : "unbound city";

  // 1. The site point itself: a geocoded address or a user point.
  evidence.push(record({
    id: "ev_site_point",
    key: "site_point",
    fact: "Site point",
    value: null,
    text: site.kind === "point"
      ? "Site point supplied by the user at " + site.point.lat + ", " + site.point.lon + " (user point, not an address match)."
      : "Site point resolved from \"" + site.query + "\" to " + site.point.lat + ", " + site.point.lon + " (address match via " + (site.geocode ? site.geocode.source : "geocoder") + ").",
    source: site.point.source === "user"
      ? { name: "User-supplied point", url: null, authority: "user", type: "user_entry" }
      : site.geocode && site.geocode.source === "mapbox"
        ? { name: "Mapbox Geocoding", url: "https://api.mapbox.com/", authority: "commercial_geocoder" }
        : { name: "OpenStreetMap Nominatim", url: "https://nominatim.openstreetmap.org/", authority: "openstreetmap" },
    scope: { level: "point", label: site.geocode ? site.geocode.place : site.point.lat + ", " + site.point.lon },
    retrievedAt: site.resolvedAt || at,
    freshness: "current",
    extraction: site.point.source === "user" ? "user_entry" : "api_json",
    extractionVersion: EXTRACTION_VERSIONS.geocode,
    status: site.point.source === "user" ? "unverified" : "available",
    hash: sha256({ lat: site.point.lat, lon: site.point.lon }),
    note: "A geocoded point locates the query. It does not establish a parcel, boundary, or ownership.",
  }));

  // 2. County, from the FCC Area API.
  evidence.push(record({
    id: "ev_county",
    key: "county",
    fact: "County",
    value: site.county ? site.county.fips : null,
    text: site.county ? "County: " + site.county.name + ", " + site.county.state + " (FIPS " + site.county.fips + ")." : "County could not be resolved for this point.",
    source: { name: "FCC Area API", url: "https://geo.fcc.gov/api/census/", authority: "federal_regulatory" },
    scope: { level: "county", geoid: site.county ? site.county.fips : null, label: site.county ? site.county.name : "unresolved county" },
    retrievedAt: site.county ? site.county.retrievedAt : at,
    freshness: "current",
    extractionVersion: EXTRACTION_VERSIONS.county,
    status: site.county ? "available" : "unavailable",
  }));

  // 3. The parcel record. Every field the feed did not publish is an
  // unavailable row of its own, so the reader sees exactly which parcel facts
  // exist rather than one opaque parcel object.
  const p = site.parcel || { status: "unavailable" };
  const parcelOk = ["verified_containing", "selected_candidate", "address_matched", "nearest_candidate"].includes(p.status);
  const parcelSource = parcelOk
    ? { name: p.source || "Parcel provider", url: p.provider === "indianamap" ? INMAP_URL : null, authority: p.provider === "indianamap" ? "state_gis" : "commercial_parcel_data", type: "gis_query" }
    : { name: "Parcel provider chain", url: null, authority: "none", type: "gis_query" };
  const parcelScope = { level: "parcel", parcelId: parcelOk ? p.id : null, label: parcelOk ? (p.address || "parcel on record") : "no parcel" };
  const parcelRetrieved = parcelOk ? p.retrievedAt : at;
  sources.parcel = p.status;
  evidence.push(record({
    id: "ev_parcel_identity",
    key: "parcel_identity",
    fact: "Parcel record",
    value: parcelOk ? (p.id || p.address || "on record") : null,
    text: parcelOk
      ? "Parcel " + (p.id ? p.id + " " : "") + (p.address ? "at " + p.address + " " : "") + "from " + p.source + ", matched by " + (p.status === "verified_containing" ? "polygon containment of the site point" : p.status === "selected_candidate" ? "user selection from the candidate list" : p.status === "address_matched" ? "recorded address matching the query, not containment" : "nearest polygon only, not containment") + "."
      : "No parcel record: " + (p.note || p.status + "."),
    source: parcelSource,
    scope: parcelScope,
    retrievedAt: parcelRetrieved,
    freshness: "unknown",
    extraction: "gis_query",
    extractionVersion: EXTRACTION_VERSIONS.parcel,
    status: parcelOk ? (p.status === "nearest_candidate" || p.status === "address_matched" ? "unverified" : "available") : "unavailable",
    coverage: parcelOk ? "Provider geometry and published attributes only; owner, assessed value, and sale history are not carried into this brief." : (p.note || null),
    hash: parcelOk && p.geometry ? sha256(p.geometry) : null,
    note: parcelOk ? p.note : null,
  }));
  evidence.push(record({
    id: "ev_parcel_lot_area",
    key: "parcel_lot_area",
    fact: "Lot area",
    value: parcelOk && p.lotSqft != null ? p.lotSqft : null,
    units: "sq ft",
    text: parcelOk && p.lotSqft != null
      ? "Lot area: " + fmt(p.lotSqft, "sq ft") + " (" + (p.lotSqftBasis === "provider_geometry_area" ? "computed from the provider polygon, not a survey" : "provider acreage field") + ")."
      : "Lot area is not available from a parcel record.",
    source: parcelSource,
    scope: parcelScope,
    retrievedAt: parcelRetrieved,
    freshness: "unknown",
    extraction: p.lotSqftBasis === "provider_geometry_area" ? "formula" : "gis_query",
    extractionVersion: EXTRACTION_VERSIONS.parcel,
    status: parcelOk && p.lotSqft != null ? (p.status === "nearest_candidate" || p.status === "address_matched" ? "unverified" : "available") : "unavailable",
    note: "Planimetric area of provider geometry; a boundary survey governs.",
  }));
  // Geometry area versus the recorded acreage: two readings of one fact.
  if (parcelOk && p.lotSqft != null && p.lotSqftFromRecord != null && p.lotSqftBasis === "provider_geometry_area") {
    const diff = Math.abs(p.lotSqft - p.lotSqftFromRecord) / Math.max(p.lotSqftFromRecord, 1);
    evidence.push(record({
      id: "ev_parcel_lot_area_record",
      key: "parcel_lot_area_record",
      fact: "Lot area (recorded acreage)",
      value: p.lotSqftFromRecord,
      units: "sq ft",
      text: "Lot area from the provider acreage field: " + fmt(p.lotSqftFromRecord, "sq ft") + ".",
      source: parcelSource,
      scope: parcelScope,
      retrievedAt: parcelRetrieved,
      freshness: "unknown",
      extraction: "gis_query",
      extractionVersion: EXTRACTION_VERSIONS.parcel,
      status: diff > 0.1 ? "conflicting" : "available",
    }));
    if (diff > 0.1) {
      evidence.find((r) => r.id === "ev_parcel_lot_area").status = "conflicting";
      conflicts.push({ id: "cf_lot_area", statement: "The polygon area and the recorded acreage differ by " + Math.round(diff * 100) + "%. The scenario uses the polygon area; a survey should settle it.", evidenceIds: ["ev_parcel_lot_area", "ev_parcel_lot_area_record"] });
    }
  }
  for (const [key, fact, field, units] of [["parcel_use", "Property class or use", "use", null], ["parcel_zoning_code", "Zoning code on the parcel record", "zoningCode", null], ["parcel_building_sqft", "Existing building area", "bldgSqft", "sq ft"], ["parcel_year_built", "Year built", "yearBuilt", null]]) {
    const v = parcelOk ? p[field] : null;
    const present = v != null && v !== "";
    evidence.push(record({
      id: "ev_" + key,
      key,
      fact,
      value: present ? v : null,
      units,
      text: present ? fact + ": " + (units ? fmt(v, units) : String(v)) + "." : fact + " is not published by this parcel feed.",
      source: parcelSource,
      scope: parcelScope,
      retrievedAt: parcelRetrieved,
      freshness: "unknown",
      extraction: "gis_query",
      extractionVersion: EXTRACTION_VERSIONS.parcel,
      status: present ? (p.status === "nearest_candidate" || p.status === "address_matched" ? "unverified" : "available") : "unavailable",
      note: key === "parcel_zoning_code" && present ? "A code string on a parcel feed is not the adopted ordinance; confirm the district and its rules with the planning office." : null,
    }));
  }

  // 4. Zoning envelope through the provider chain. Today every adapter is a
  // pending integration, so this row is honest about being unavailable.
  let z = null;
  try { z = await zoning({ lat: site.point.lat, lon: site.point.lon }); } catch { z = null; }
  const zOk = !!(z && z.ok && z.envelope);
  sources.zoning = zOk ? "available" : (z && Array.isArray(z.tried) && z.tried.every((t) => t.status === "no_key") ? "no_key" : "unavailable");
  evidence.push(record({
    id: "ev_zoning_envelope",
    key: "zoning_envelope",
    fact: "Zoning envelope (district, permitted uses, height, setbacks, density, parking)",
    value: zOk ? z.envelope : null,
    text: zOk ? "Zoning envelope from " + (z.provider || "provider") + "." : "No zoning envelope is available: " + (sources.zoning === "no_key" ? "no zoning data provider is configured for this deployment (" + (z && z.tried ? z.tried.map((t) => t.provider).join(", ") : "none") + ")." : "the zoning lookup did not resolve."),
    source: zOk ? { name: z.provider, url: null, authority: "commercial_zoning_data" } : { name: "Zoning provider chain", url: null, authority: "none" },
    scope: parcelScope,
    retrievedAt: at,
    freshness: zOk ? "unknown" : "unknown",
    extractionVersion: EXTRACTION_VERSIONS.zoning,
    status: zOk ? "available" : "unavailable",
    note: "Permitted use, height, setbacks, density, and parking minimums must come from the adopted ordinance. Nothing in this brief assumes them.",
  }));

  // 5. City fundamentals, from Cividian's ACS read. Context, never site.
  let c = null;
  if (site.city && site.state) { try { c = await getCity(site.city, site.state, { lat: site.point.lat, lon: site.point.lon }); } catch { c = null; } }
  const cityOk = !!(c && c.found);
  const cityErr = !site.city || !site.state ? "city_unbound" : !cityOk ? String((c && c.error) || "census_unavailable") : null;
  sources.city = cityOk ? "available" : /CENSUS_API_KEY/.test(cityErr || "") ? "no_key" : cityErr;
  const acsUrl = cityOk && c.census && c.census.year ? "https://api.census.gov/data/" + c.census.year + "/acs/acs5" : "https://api.census.gov/data/";
  const cityGeoid = cityOk && c.stateFips && c.placeFips ? String(c.stateFips) + String(c.placeFips) : null;
  const cityScope = { level: "city", geoid: cityGeoid, label: placeLabel + " (Census place)" };
  const citySource = { name: cityOk ? (c.source || "US Census ACS 5-year") : "US Census ACS 5-year", url: acsUrl, authority: "federal_statistical" };
  const cityStatus = cityOk ? stalenessStatus(c.asOf, now) : "unavailable";
  const cityRetrieved = cityOk ? ((c.census && c.census.retrievedAt) || at) : at;
  for (const [key, fact, field, units, table] of [["city_population", "Population", "population", "people", "B01003_001E"], ["city_median_income", "Median household income", "medianIncome", "USD", "B19013_001E"], ["city_median_home_value", "Median owner-occupied home value", "medianHomeValue", "USD", "B25077_001E"], ["city_vacancy_pct", "Housing vacancy", "vacancyPct", "%", "B25002"]]) {
    const v = cityOk ? c[field] : null;
    const present = typeof v === "number" && Number.isFinite(v);
    evidence.push(record({
      id: "ev_" + key,
      key,
      fact,
      value: present ? v : null,
      units,
      text: present
        ? fact + " for " + placeLabel + ": " + fmt(v, units) + " (" + c.asOf + ", " + (units === "%" ? "calculated from " : "") + table + ")."
        : cityOk ? fact + " was not published for this place in " + c.asOf + "." : fact + " is unavailable: " + describeCityError(cityErr) + ".",
      source: citySource,
      scope: cityScope,
      retrievedAt: cityRetrieved,
      vintage: cityOk ? c.asOf : null,
      freshness: cityOk ? "historical_vintage" : "unknown",
      extraction: units === "%" ? "formula" : "api_json",
      extractionVersion: EXTRACTION_VERSIONS.acs,
      status: present ? cityStatus : "unavailable",
      coverage: "City-wide estimate for the Census place. It does not describe the parcel or its block.",
      hash: present ? sha256({ geoid: cityGeoid, key, v, asOf: c.asOf }) : null,
      note: present && cityStatus === "stale" ? "This vintage is three or more years old. Verify against newer data before relying on it." : null,
    }));
  }
  // The Cividian Score is a heuristic composite, so it is a calculation row
  // with its own provenance, never a source observation.
  evidence.push(record({
    id: "ev_city_score",
    kind: "deterministic_calculation",
    key: "city_score",
    fact: "Cividian Score (heuristic composite)",
    value: cityOk && typeof c.score === "number" ? c.score : null,
    units: "index 0 to 100",
    text: cityOk && typeof c.score === "number"
      ? "Cividian Score for " + placeLabel + ": " + c.score + " of 100, a heuristic screening composite over the ACS reads and any resolved live layers; not a site metric and not a recommendation."
      : "No Cividian Score resolved for " + placeLabel + (cityOk && c.scoreNote ? ": " + c.scoreNote : "") + ".",
    source: { name: "Cividian scoring model " + ((c && c.decision && c.decision.modelVersion) || "heuristic"), url: null, authority: "cividian_calculation", type: "formula" },
    scope: cityScope,
    retrievedAt: cityRetrieved,
    vintage: cityOk ? c.asOf : null,
    freshness: cityOk ? "historical_vintage" : "unknown",
    extraction: "formula",
    extractionVersion: EXTRACTION_VERSIONS.score,
    status: cityOk && typeof c.score === "number" ? "available" : "unavailable",
    coverage: cityOk && c.liveWeightShare != null ? "Resolved model weighting " + c.liveWeightShare + "% of the published weights." : null,
  }));

  // 6. County market gaps from County Business Patterns. County scope.
  let g = null;
  try { g = await gaps(site.point.lat, site.point.lon); } catch { g = null; }
  const gOk = !!(g && g.ok && Array.isArray(g.categories));
  sources.gaps = gOk ? "available" : g && /requires a key/.test(String(g.note || "")) ? "no_key" : "unavailable";
  const wanted = objectiveId === "mixed_use" ? ["4451", "7225", "4481", "8121"] : objectiveId === "adaptive_reuse" ? ["7225", "6211", "7139", "8121"] : ["4451", "7225", "6244", "7139"];
  const countyScope = { level: "county", geoid: site.county ? site.county.fips : null, label: site.county ? site.county.name : "unresolved county" };
  if (gOk) {
    for (const naics of wanted) {
      const cat = g.categories.find((x) => x.naics === naics);
      if (!cat) continue;
      evidence.push(record({
        id: "ev_county_gaps_" + naics,
        key: "county_gaps",
        fact: cat.label + " per 10,000 residents",
        value: cat.localPer10k,
        units: "establishments per 10k",
        text: cat.label + " in " + countyScope.label + ": " + cat.localPer10k + " establishments per 10,000 residents versus " + cat.usPer10k + " nationally (ratio " + cat.ratio + ", " + cat.status.replace(/_/g, " ") + "; CBP " + g.year + ").",
        source: { name: "US Census County Business Patterns " + g.year + " and ACS population", url: "https://api.census.gov/data/" + g.year + "/cbp", authority: "federal_statistical" },
        scope: countyScope,
        retrievedAt: at,
        vintage: "CBP " + g.year,
        freshness: "historical_vintage",
        extraction: "formula",
        extractionVersion: EXTRACTION_VERSIONS.gaps,
        status: stalenessStatus(String(g.year), now),
        coverage: "County-wide establishment rate. A screening signal for the county, not the parcel's trade area.",
        hash: sha256({ fips: countyScope.geoid, naics, cat }),
      }));
    }
  } else {
    evidence.push(record({
      id: "ev_county_gaps",
      key: "county_gaps",
      fact: "County market gaps (establishments per 10,000 residents by category)",
      value: null,
      text: "County market gap scan is unavailable: " + (sources.gaps === "no_key" ? "the Census API requires a key and none is configured for this deployment." : String((g && g.note) || "the scan did not complete.")),
      source: { name: "US Census County Business Patterns", url: "https://www.census.gov/programs-surveys/cbp.html", authority: "federal_statistical" },
      scope: countyScope,
      retrievedAt: at,
      freshness: "unknown",
      extractionVersion: EXTRACTION_VERSIONS.gaps,
      status: "unavailable",
    }));
  }

  // 7. Unknowns: required keys with no available row, plus rows that are stale.
  const req = REQUIRED_EVIDENCE[objectiveId] || REQUIRED_EVIDENCE.residential_infill;
  const byKey = (k) => evidence.filter((r) => r.key === k);
  const unknowns = [];
  for (const [applicability, keys] of [["site", req.site], ["context", req.context]]) {
    for (const k of keys) {
      const rows = byKey(k);
      const available = rows.some((r) => r.status === "available" || r.status === "stale" || r.status === "conflicting");
      if (!available) {
        const rec = rows[0];
        unknowns.push({ id: "unk_" + k, key: k, applicability, statement: rec ? rec.text : k + " is not available.", impact: applicability === "site" ? "high" : "medium", evidenceIds: rows.map((r) => r.id) });
      } else if (rows.some((r) => r.status === "stale")) {
        unknowns.push({ id: "unk_stale_" + k, key: k, applicability, statement: rows[0].fact + " comes from a vintage three or more years old (" + rows[0].vintage + ").", impact: "medium", evidenceIds: rows.map((r) => r.id) });
      }
    }
  }
  // Always-unknown items no source in this deployment answers.
  for (const [k, statement] of [["market_rent", "Achievable rents and absorption are not established by any source in this brief."], ["construction_cost", "Construction cost is not established by any source in this brief."], ["utility_capacity", "Utility capacity and connection cost are not established by any source in this brief."], ["environmental", "Environmental condition and floodplain status are not established by any source in this brief."], ["title", "Ownership, liens, and easements are not established by any source in this brief."]]) {
    unknowns.push({ id: "unk_" + k, key: k, applicability: "site", statement, impact: k === "title" || k === "environmental" ? "high" : "high", evidenceIds: [] });
  }

  return { evidence, unknowns, conflicts, sources, gatheredAt: at, questions: questionsFor(objectiveId).map((q) => q.id) };
}

function describeCityError(err) {
  if (!err) return "the read did not resolve";
  if (err === "city_unbound") return "no city and state are bound to this site";
  if (/CENSUS_API_KEY/.test(err)) return "a Census API key is required and none is configured for this deployment";
  if (/place not found/.test(err)) return "the Census place list has no place by that name in that state";
  if (/unknown state/.test(err)) return "the state was not recognized";
  return "the Census read did not resolve";
}

// Unsupported user assumptions: an assumption that contradicts a source
// observation is flagged as a conflict and both records stay visible.
export function assumptionConflicts(assumptions, evidence) {
  const out = [];
  const existing = evidence.find((r) => r.key === "parcel_building_sqft" && r.value != null);
  const a = assumptions.find((x) => x.key === "existingBldgSqft" && x.basis === "user_assumption" && x.value != null);
  if (existing && a && Math.abs(existing.value - a.value) / Math.max(existing.value, 1) > 0.15) {
    out.push({ id: "cf_existing_building", statement: "The user-entered existing building area (" + fmt(a.value, "sq ft") + ") differs from the parcel record (" + fmt(existing.value, "sq ft") + ") by more than 15%. The parcel record is used; the assumption is unsupported until measured.", evidenceIds: [existing.id], assumptionIds: [a.id] });
  }
  const lotRec = evidence.find((r) => r.key === "parcel_lot_area" && r.value != null);
  const lotA = assumptions.find((x) => x.key === "lotSqftOverride" && x.basis === "user_assumption" && x.value != null);
  if (lotRec && lotA && Math.abs(lotRec.value - lotA.value) / Math.max(lotRec.value, 1) > 0.15) {
    out.push({ id: "cf_lot_override", statement: "The user-entered lot area (" + fmt(lotA.value, "sq ft") + ") differs from the parcel record (" + fmt(lotRec.value, "sq ft") + ") by more than 15%. The parcel record is used; the override is ignored until a survey supports it.", evidenceIds: [lotRec.id], assumptionIds: [lotA.id] });
  }
  return out;
}
