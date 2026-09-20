// lib/gaps.js
// Market Gap Scan. Absorbs the "retail void analysis" concept the enterprise
// site-selection vendors sell behind contact-sales walls, rebuilt on public
// primary sources with full provenance:
//   1. FCC Area API resolves lat/lon -> county FIPS (public, keyless).
//   2. Census County Business Patterns (CBP) gives establishment counts by
//      NAICS for the county and for the US.
//   3. Census ACS 5-year gives county and US population.
// The scan compares establishments-per-10k-residents locally vs nationally.
// Everything is cached in Redis; nothing is fabricated. If any source fails,
// the scan says so instead of guessing.
//
// Pure module: no req, no res, and it never throws. api/gaps.js is only the
// HTTP skin over marketGaps below. The four source readers stay exported
// because api/criteria.js, api/opportunities.js and api/wizard.js compose
// their own layers out of the same cached county reads, and must hit the same
// cache keys rather than re-fetching CBP and ACS per endpoint.
import { cached } from './cache.js';
import { censusConfig } from './census.js';

const TIMEOUT_MS = 9000;

// Curated categories a developer or site selector actually underwrites.
// Labels are fallbacks; when CBP returns its own label we use that.
export const CATS = [
  { naics: '4451', label: 'Grocery stores' },
  { naics: '4461', label: 'Health & personal care stores' },
  { naics: '4471', label: 'Gasoline stations' },
  { naics: '4481', label: 'Clothing stores' },
  { naics: '452',  label: 'General merchandise stores' },
  { naics: '7225', label: 'Restaurants & other eating places' },
  { naics: '7139', label: 'Fitness & recreation' },
  { naics: '6244', label: 'Child day care services' },
  { naics: '8121', label: 'Personal care services' },
  { naics: '6211', label: 'Offices of physicians' },
  { naics: '7211', label: 'Hotels & traveler accommodation' }
];

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status, json: null };
    const j = await r.json().catch(function () { return null; });
    return { ok: true, status: r.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: null };
  } finally { clearTimeout(t); }
}

function censusKey() {
  return process.env.CENSUS_API_KEY || process.env.Census_data || process.env.CENSUS_DATA || process.env.CENSUS_KEY || '';
}
function withKey(url) {
  const k = censusKey();
  return k ? url + '&key=' + encodeURIComponent(k) : url;
}

// lat/lon -> { countyFips5, countyName, stateCode } via the FCC Area API.
export async function countyForPoint(lat, lon) {
  const rl = Math.round(lat * 500) / 500, rn = Math.round(lon * 500) / 500;
  return cached('fcc-county:' + rl + ',' + rn, 60 * 60 * 24 * 30, async function () {
    const r = await getJSON('https://geo.fcc.gov/api/census/area?lat=' + lat + '&lon=' + lon + '&format=json');
    const a = r.json && r.json.results && r.json.results[0];
    if (!a || !a.county_fips) return null;
    return { fips: String(a.county_fips), name: a.county_name || 'County', state: a.state_code || '' };
  });
}

// CBP establishment counts for every published NAICS in one call, then we
// filter locally. One request instead of eleven; cached 30 days.
// Verified against api.census.gov 2026-07-04: CBP 2023/2022 publish NAICS2017
// but no *_LABEL variable, so labels come from the curated list above.
export async function cbpTable(scopeQS, cacheKey) {
  return cached(cacheKey, 60 * 60 * 24 * 30, async function () {
    const years = ['2023', '2022'];
    for (let i = 0; i < years.length; i++) {
      const url = withKey('https://api.census.gov/data/' + years[i] + '/cbp?get=ESTAB,NAICS2017&' + scopeQS);
      const r = await getJSON(url);
      if (r.ok && Array.isArray(r.json) && r.json.length > 1) {
        const head = r.json[0];
        const iE = head.indexOf('ESTAB'), iN = head.indexOf('NAICS2017');
        const map = {};
        for (let j = 1; j < r.json.length; j++) {
          const row = r.json[j];
          // `parseInt(x) || 0` mapped a withheld cell to whatever it parsed to,
          // and CBP marks a withheld cell with a negative sentinel rather than
          // omitting it, so a negative establishment count survived into the
          // per-10k rate and came out the far end as a NEGATIVE local rate,
          // which reads below every band and lands in "underserved". A count
          // the Census declined to publish is null here and stays null. An
          // omitted row still means a real zero and is handled by the reader.
          const e = parseInt(row[iE], 10);
          map[row[iN]] = { estab: Number.isFinite(e) && e >= 0 ? e : null };
        }
        return { year: years[i], map: map };
      }
    }
    return null;
  });
}

// ACS 5-year total population for a geography; cached 30 days.
export async function acsPop(scopeQS, cacheKey) {
  const vintage = censusConfig();
  return cached(cacheKey + ':acs5:' + vintage.year, 60 * 60 * 24 * 30, async function () {
    const url = withKey(vintage.apiBase + '?get=B01003_001E&' + scopeQS);
    const r = await getJSON(url);
    if (r.ok && Array.isArray(r.json) && r.json[1]) {
      const p = parseInt(r.json[1][0]);
      return isFinite(p) && p > 0 ? { pop: p, source: vintage.source, asOf: vintage.asOf } : null;
    }
    return null;
  });
}

export function statusFor(ratio) {
  if (ratio < 0.55) return 'underserved';
  if (ratio < 0.85) return 'below_typical';
  if (ratio <= 1.2) return 'in_line';
  return 'crowded';
}

// The whole scan behind one call: point -> county -> CBP and ACS -> per-10k
// comparison, returning the response envelope itself so every caller gets the
// same honest shape without rebuilding it. The coordinate guard lives here
// rather than in the HTTP layer so an off-HTTP caller cannot skip it.
export async function marketGaps(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) {
    return { ok: false, note: 'A gap scan needs a point. Supply lat and lon in decimal degrees.' };
  }
  try {
    const county = await countyForPoint(lat, lon);
    if (!county) {
      return { ok: false, coverage: 'unavailable', note: 'County could not be resolved for this point right now. No gap figures are shown without a verified county.' };
    }
    const st = county.fips.slice(0, 2), co = county.fips.slice(2);

    const [local, national, cPop, uPop] = await Promise.all([
      cbpTable('for=county:' + co + '&in=state:' + st, 'cbp:county:' + county.fips),
      cbpTable('for=us:1', 'cbp:us'),
      acsPop('for=county:' + co + '&in=state:' + st, 'acspop:county:' + county.fips),
      acsPop('for=us:1', 'acspop:us')
    ]);

    if (!local || !national || !cPop || !uPop) {
      return {
        ok: false, coverage: 'unavailable',
        county: { name: county.name, state: county.state, fips: county.fips },
        note: censusKey()
          ? 'Census County Business Patterns or ACS did not respond for this county. Cividian reports the miss instead of estimating.'
          : 'The Census API now requires a key for every request and none is configured in this environment. No gap figures are shown without the source.'
      };
    }

    const cats = CATS.map(function (c) {
      const L = local.map[c.naics];             // missing row = zero establishments published
      const N = national.map[c.naics];
      // The benchmark must be a real positive count. `!N.estab` let a negative
      // sentinel through, because a negative number is truthy.
      if (!N || N.estab == null || !(N.estab > 0)) return null;  // never invent a benchmark
      // A present row whose count was withheld is not a zero. Reported as a
      // gap it would be the strongest possible "nobody serves this" signal,
      // built on a figure the Census specifically refused to state. Warm cache
      // entries written before this guard can still hold a negative, so the
      // check is on the value rather than on its absence.
      const le = L ? (L.estab != null && L.estab >= 0 ? L.estab : null) : 0;
      if (le == null) return null;
      const localRate = (le / cPop.pop) * 10000;
      const usRate = (N.estab / uPop.pop) * 10000;
      const ratio = usRate > 0 ? localRate / usRate : null;
      if (ratio == null) return null;
      return {
        naics: c.naics,
        label: c.label,
        localEstab: le,
        localPer10k: Math.round(localRate * 100) / 100,
        usPer10k: Math.round(usRate * 100) / 100,
        ratio: Math.round(ratio * 100) / 100,
        status: statusFor(ratio)
      };
    }).filter(Boolean).sort(function (a, b) { return a.ratio - b.ratio; });

    return {
      ok: true,
      county: { name: county.name, state: county.state, fips: county.fips },
      population: cPop.pop,
      year: local.year,
      categories: cats,
      provenance: [
        'US Census County Business Patterns ' + local.year + ' (establishments by NAICS, county ' + county.fips + ' and US)',
        censusConfig().source + ' B01003 (population, county and US; independent from the CBP vintage)' ,
        'FCC Area API (point to county resolution)'
      ],
      note: 'Per-10k-resident establishment rates vs the national rate. A low ratio flags a possible service gap; it is a screening signal, not a feasibility conclusion. Verify with trade-area work before underwriting.'
    };
  } catch (e) {
    // The readers above swallow their own vendor and cache failures, so this
    // is not the path a dead Census API takes. It exists so the contract
    // "marketGaps never throws" survives a future edit inside the module and
    // cannot turn a caller into a 500.
    console.log('PAGO_GAPS_ERR ' + String((e && e.message) || e));
    return { ok: false, coverage: 'unavailable', note: 'The market gap scan could not complete for this point right now. No gap figures are shown without a verified source read.' };
  }
}
