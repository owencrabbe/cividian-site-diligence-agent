// test/diligence/helpers.mjs
// Scripted sources for the Site Diligence Agent tests and evaluations. Nothing
// here touches the network. Every fixture is synthetic and says so in its own
// provenance strings, so a fixture value can never be mistaken for a read.

export const SYNTHETIC = "SYNTHETIC FIXTURE, not a source read";

// A square parcel roughly 30 m on a side around a point, as provider geometry.
export function squareAround(lat, lon, meters = 30) {
  const dLat = meters / 111320, dLon = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return { type: "Polygon", coordinates: [[[lon - dLon / 2, lat - dLat / 2], [lon + dLon / 2, lat - dLat / 2], [lon + dLon / 2, lat + dLat / 2], [lon - dLon / 2, lat + dLat / 2], [lon - dLon / 2, lat - dLat / 2]]] };
}

export const POINT = { lat: 40.19628, lon: -85.387806 };

export function geocodeOk(overrides = {}) {
  return async (q, o) => ({ ok: true, lat: POINT.lat, lon: POINT.lon, bbox: null, place: "300, North High Street, Muncie, Delaware County, Indiana, 47305, United States (" + SYNTHETIC + ")", city: "Muncie", state: "Indiana", kind: /\d/.test(q) || (o && o.mode === "address") ? "address" : "place", source: "osm", ...overrides });
}
export const countyOk = async () => ({ fips: "18035", name: "Delaware County", state: "IN" });

export function parcelsOk(opts = {}) {
  const geom = opts.geometry || squareAround(POINT.lat, POINT.lon, 30);
  const p = { geometry: geom, addr: opts.addr || "300 N HIGH ST, MUNCIE (" + SYNTHETIC + ")", owner: "SHOULD NEVER APPEAR", salePrice: 123, saleDate: "2020-01-01", use: "Class 500", zoning: opts.zoning === undefined ? "" : opts.zoning, acre: opts.acre === undefined ? null : opts.acre, value: 999, bldgSqft: opts.bldgSqft === undefined ? null : opts.bldgSqft, bldgFootprintSqft: null, yearBuilt: opts.yearBuilt === undefined ? null : opts.yearBuilt, source: "Delaware County via IndianaMap (" + SYNTHETIC + ")", id: opts.id === undefined ? "18-11-01-234-005.000-003" : opts.id };
  const far = { ...p, geometry: squareAround(POINT.lat + 0.002, POINT.lon + 0.002, 30), addr: "999 FAR ST, MUNCIE (" + SYNTHETIC + ")", id: "far-parcel" };
  return async () => ({ ok: true, provider: "indianamap", coverage: "covered", count: 2, parcels: opts.noneContain ? [far] : [p, far], tried: [] });
}
export const parcelsNoKey = async () => ({ ok: false, provider: null, coverage: "no_key", parcels: [], tried: [{ provider: "reportall", status: "no_key" }] });
export const parcelsNoCoverage = async () => ({ ok: false, provider: null, coverage: "no_coverage", parcels: [], tried: [] });

export function cityOk(overrides = {}) {
  return async () => ({ found: true, name: "Muncie", state: "Indiana", stateFips: "18", placeFips: "51876", population: 65194, medianIncome: 43400, medianHomeValue: 92000, vacancyPct: 13.6, source: "US Census ACS 5-year 2023", asOf: "2023 ACS 5-year", census: { year: "2023", retrievedAt: "2026-09-01T00:00:00.000Z" }, score: 56, verdict: { tag: "WATCH" }, liveWeightShare: 65, decision: { modelVersion: "cividian-city-score.us.v1" }, scoreNote: null, ...overrides });
}
export const cityNoKey = async () => ({ found: false, error: "Set CENSUS_API_KEY in Vercel." });
export const cityNotFound = async () => ({ found: false, error: "place not found" });
export function gapsOk() {
  return async () => ({ ok: true, county: { name: "Delaware County", state: "IN", fips: "18035" }, population: 111000, year: 2023, categories: [{ naics: "4451", label: "Grocery stores", localEstab: 20, localPer10k: 1.8, usPer10k: 2.1, ratio: 0.86, status: "in_line" }, { naics: "7225", label: "Restaurants & other eating places", localEstab: 200, localPer10k: 18, usPer10k: 20.5, ratio: 0.88, status: "in_line" }, { naics: "6244", label: "Child day care services", localEstab: 12, localPer10k: 1.08, usPer10k: 2.3, ratio: 0.47, status: "underserved" }, { naics: "7139", label: "Fitness & recreation", localEstab: 15, localPer10k: 1.35, usPer10k: 2.0, ratio: 0.68, status: "below_typical" }] });
}
export const gapsNoKey = async () => ({ ok: false, coverage: "unavailable", note: "The Census API now requires a key for every request and none is configured in this environment." });
export const zoningNoKey = async () => ({ ok: false, provider: null, envelope: null, source: "none", tried: [{ provider: "gridics", status: "no_key" }, { provider: "zoneomics", status: "no_key" }] });

export const NOW_2026 = () => new Date("2026-09-19T12:00:00.000Z");

export function deps(overrides = {}) {
  return {
    site: { geocode: geocodeOk(), county: countyOk, parcels: parcelsOk(), now: NOW_2026, ...(overrides.site || {}) },
    evidence: { getCity: cityOk(), gaps: gapsOk(), zoning: zoningNoKey, now: NOW_2026, ...(overrides.evidence || {}) },
    scenarios: overrides.scenarios || {},
    env: overrides.env || { AUTH_SECRET: "x".repeat(40), DILIGENCE_FIXTURE_MODE: "1" },
    complete: overrides.complete,
    transport: overrides.transport,
    connect: overrides.connect,
  };
}

export const SITE_INPUT = { query: "300 N High St, Muncie, IN" };
export const GUEST_OWNER = { kind: "guest", key: "guest:test-guest-owner", ttl: 86400 };
export const OTHER_OWNER = { kind: "guest", key: "guest:another-guest", ttl: 86400 };
export const ACCOUNT_OWNER = { kind: "account", key: "acct:test-account", ttl: null };

export async function runToBrief(brief, { objective = "residential_infill", assumptions = { hardCostPerSqft: 210, rentPerSqftMonth: 1.6, capRatePct: 7 }, owner = GUEST_OWNER, d = deps(), site = SITE_INPUT } = {}) {
  const started = await brief.startRun({ site: await siteFor(site, d), objective, assumptions }, owner, d);
  if (!started.ok) return started;
  return brief.reasonRun(started.brief.id, owner, d, {});
}

export async function siteFor(input, d) {
  const { resolveSite } = await import("../../lib/diligence/site.js");
  const r = await resolveSite(input, d.site);
  if (!r.ok) throw new Error("site fixture failed: " + r.error);
  return r.site;
}
