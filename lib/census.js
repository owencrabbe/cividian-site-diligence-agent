// One reviewed ACS registry for data, cache identity, citations and migration.
// Keep the default stable until an operator explicitly rolls a verified vintage
// into an environment. A query string can never change the deployment policy.
export const ACS_DEFAULT_YEAR = '2023';
export const ACS_SUPPORTED_YEARS = Object.freeze(['2023', '2024']);

export function acsVintage(year = ACS_DEFAULT_YEAR) {
  if (typeof year !== 'string' || !ACS_SUPPORTED_YEARS.includes(year)) {
    throw new TypeError('Unsupported CENSUS_ACS_YEAR. Use an explicitly supported four-digit vintage.');
  }
  return Object.freeze({
    schema: 'census-acs-vintage.v1', dataset: 'acs/acs5', year,
    periodStart: Number(year) - 4, periodEnd: Number(year),
    source: `US Census ACS 5-year ${year}`, asOf: `${year} ACS 5-year`,
    period: `${Number(year) - 4}–${year}`,
    apiBase: `https://api.census.gov/data/${year}/acs/acs5`,
  });
}

export function censusConfig(env = process.env) {
  return acsVintage(env.CENSUS_ACS_YEAR === undefined ? ACS_DEFAULT_YEAR : env.CENSUS_ACS_YEAR);
}

// Exact labels are a bounded bridge for already-issued 2023 records. Unknown
// years and contradictory metadata never inherit today's configured vintage.
export function recordVintage(record) {
  if (!record || typeof record !== 'object') return null;
  return ACS_SUPPORTED_YEARS.map(acsVintage).find(v =>
    [v.source, v.source + ', state geography'].includes(record.source) && record.asOf === v.asOf &&
    (record.census === undefined || (record.census?.schema === v.schema && record.census?.dataset === v.dataset &&
      record.census?.year === v.year && record.census?.periodStart === v.periodStart && record.census?.periodEnd === v.periodEnd))) || null;
}

export function censusMetadata(vintage, retrievedAt) {
  const { schema, dataset, year, periodStart, periodEnd } = vintage;
  return { schema, dataset, year, periodStart, periodEnd, retrievedAt };
}

export function cityCacheKey(fips, name, vintage = censusConfig()) {
  return `pago:city:acs5:${vintage.year}:${fips}:${String(name).trim().toLowerCase()}`;
}
export function stateCacheKey(fips, vintage = censusConfig()) {
  return `pago:st:acs5:${vintage.year}:${fips}`;
}

// Monitoring compares like-for-like model readings, not different survey
// periods, identities or coverage. An unversioned historical score is unknown.
export function cityReadingSignature(read) {
  const d = read?.decision, v = recordVintage(read);
  if (!v || !d?.modelVersion || !d.geography?.stateFips || (d.geography?.scope !== 'state' && !d.geography?.placeFips) ||
      !Number.isFinite(d.coverage?.resolvedWeightPct)) return null;
  return JSON.stringify({ year: v.year, dataset: v.dataset, model: d.modelVersion,
    geography: `${d.geography.scope === 'state' ? 'state' : 'city'}:${d.geography.stateFips}:${d.geography.placeFips || ''}`,
    coverage: d.coverage.resolvedWeightPct,
    layers: Object.entries(d.layers || {}).map(([key, layer]) => [key, layer.status]).sort(),
  });
}

// Saved observations lacking this signature remain visible, but cannot establish
// a comparable delta. Do not infer the old model/coverage after the fact.
export function comparableObservations(a, b) {
  return typeof a?.comparisonSignature === 'string' && a.comparisonSignature.length > 0 && a.comparisonSignature === b?.comparisonSignature;
}
