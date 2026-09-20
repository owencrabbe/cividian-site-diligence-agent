// lib/citydata.js
// One honest city read, shared by /api/city (the JSON API) and the public
// server-rendered city pages (/city/<slug>). Cache-first on the raw ACS record,
// a live US Census ACS 5-year read when a key is present, then the server-side
// Cividian Score computed from whatever layers are cache-warm. Nothing is
// fabricated: a place with no verified read returns { found:false, error }, and
// the score is recomputed on every call so late-resolving live layers bind.
import { getKey, setKey, setKeyEx, multiPush } from './redis.js';
import { computeScore } from './scoring.js';
import { liveLayers } from './layers.js';
import { fetchWithTimeout } from './http.js';
import { FIPS, ABBR } from './fips.js';
import { obsPlaceKey } from './history.js';
import { censusConfig, censusMetadata, cityCacheKey, stateCacheKey, recordVintage, cityReadingSignature } from './census.js';

export function resolveStateFips(st) {
  return FIPS[String(st || '').toLowerCase()] || ABBR[String(st || '').toUpperCase()] || null;
}

const normalizePlace = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function censusIdentity(censusName) {
  if (typeof censusName !== 'string' || !censusName.includes(',')) return null;
  const split = censusName.lastIndexOf(',');
  const legalName = censusName.slice(0, split).trim();
  const state = censusName.slice(split + 1).trim();
  // Strip only a Census geographic-type suffix from the returned legal name.
  // Never strip a user's query: "Kansas City" and "Carson City" contain City
  // as part of their names. Compound geography types precede simple suffixes.
  // Census type words are lowercase (except CDP). Keeping that case matters:
  // "Carson City, Nevada" has no appended type and must keep its proper name.
  const name = legalName.replace(/ (?:city and borough|city and county|unified government|consolidated government)(?: \(balance\))?$| (?:city|town|village|borough|municipality|CDP|comunidad|zona urbana)(?: \(balance\))?$/, '').trim();
  if (!name || !resolveStateFips(state)) return null;
  return { name, legalName, state, censusName };
}
function matchesIdentity(identity, query) {
  const wanted = normalizePlace(query);
  return wanted && [identity.name, identity.legalName, identity.censusName].some(value => normalizePlace(value) === wanted);
}

// Exact normalized identity matching, never a prefix ranking. If two legal
// places share a name, require the caller to choose a geographic qualifier.
export function matchCensusPlace(rows, queryName, stateFips) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) return { found: false, error: 'census error' };
  const header = rows[0], nameIndex = header.indexOf('NAME'), stateIndex = header.indexOf('state'), placeIndex = header.indexOf('place');
  if (nameIndex < 0 || stateIndex < 0 || placeIndex < 0) return { found: false, error: 'census error' };
  const matches = [];
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || row[stateIndex] !== stateFips || !/^\d{5}$/.test(row[placeIndex])) continue;
    const identity = censusIdentity(row[nameIndex]);
    if (!identity || resolveStateFips(identity.state) !== stateFips || !matchesIdentity(identity, queryName)) continue;
    matches.push({ row, identity, stateFips, placeFips: row[placeIndex] });
  }
  if (!matches.length) return { found: false, error: 'place not found' };
  if (matches.length > 1) return { found: false, error: 'ambiguous place', message: 'Choose the full Census place name, including city, town, village or CDP.', matches: matches.map(({ identity, placeFips }) => ({ censusName: identity.censusName, placeFips, stateFips })) };
  return { found: true, ...matches[0] };
}

export function verifiedCityIdentity(base, queryName, stateFips) {
  if (!base?.found || base.geographySchema !== 'census-place.v1' || base.stateFips !== stateFips || !/^\d{5}$/.test(base.placeFips)) return false;
  const identity = censusIdentity(base.censusName);
  return !!identity && resolveStateFips(identity.state) === stateFips && normalizePlace(base.name) === normalizePlace(identity.name) && matchesIdentity(identity, queryName);
}

// Cache-first ACS base record. Returns { found:true, ...base } or
// { found:false, error }. `allowLive` false restricts to cache (no vendor call).
export async function readCachedCityBase(name, st) {
  const fips = Object.values(FIPS).includes(st) ? st : resolveStateFips(st), nm = String(name || '').trim(), vintage = censusConfig();
  if (!fips || !nm) return null;
  const accepts = record => verifiedCityIdentity(record, nm, fips) && recordVintage(record)?.year === vintage.year;
  const cached = await getKey(cityCacheKey(fips, nm, vintage));
  if (accepts(cached)) return { ...cached, cached: true };
  // Read-only compatibility: never relabel or overwrite a legacy cache row.
  if (vintage.year === '2023') {
    const legacy = await getKey('pago:city:' + fips + ':' + nm.toLowerCase());
    if (accepts(legacy)) return { ...legacy, cached: true, cacheCompatibility: 'legacy_2023' };
  }
  return null;
}

export async function readCachedStateBase(fips) {
  if (!Object.values(FIPS).includes(fips)) return null;
  const vintage = censusConfig();
  const accepts = record => record?.found && record.scope === 'state' && record.stateFips === fips && recordVintage(record)?.year === vintage.year;
  const current = await getKey(stateCacheKey(fips, vintage));
  if (accepts(current)) return { ...current, cached: true };
  if (vintage.year === '2023') {
    const legacy = await getKey('pago:st:' + fips);
    if (accepts(legacy)) return { ...legacy, cached: true, cacheCompatibility: 'legacy_2023' };
  }
  return null;
}

export async function readCityBase(name, st, { allowLive = true } = {}) {
  const nm = String(name || '').trim();
  const state = String(st || '').trim();
  if (!nm || !state) return { found: false, error: 'name and state required' };
  const fips = resolveStateFips(state);
  if (!fips) return { found: false, error: 'unknown state' };

  const vintage = censusConfig();
  const cacheKey = cityCacheKey(fips, nm, vintage);
  const cached = await readCachedCityBase(nm, state);
  // Older rows stored the caller's spelling as `name`, so a prefix mismatch
  // cannot be disproved from that field. Refresh those rows instead of letting
  // a pre-fix wrong-place result remain authoritative for another 30 days.
  if (cached) return cached;

  const key = process.env.CENSUS_API_KEY || process.env.Census_data || process.env.CENSUS_DATA || process.env.CENSUS_KEY;
  if (!allowLive) return { found: false, error: 'no_cache' };
  if (!key) return { found: false, error: 'Set CENSUS_API_KEY in Vercel.' };

  const vars = 'NAME,B01003_001E,B19013_001E,B25077_001E,B25002_001E,B25002_003E';
  const url = vintage.apiBase + '?get=' + vars + '&for=place:*&in=state:' + fips + '&key=' + encodeURIComponent(key);
  const r = await fetchWithTimeout(url, 8000);
  if (!r.ok) return { found: false, error: 'census error' };
  const rows = await r.json();
  if (!Array.isArray(rows)) return { found: false, error: 'census error' };
  const match = matchCensusPlace(rows, nm, fips);
  if (!match.found) return match;
  const row = match.row;
  function num(v) { const n = parseInt(v, 10); return (isNaN(n) || n < 0) ? null : n; }
  const pop = num(row[1]), inc = num(row[2]), home = num(row[3]), tot = num(row[4]), vac = num(row[5]);
  const vacancyPct = (tot && vac != null) ? Math.round((vac / tot) * 1000) / 10 : null;
  const base = { found: true, name: match.identity.name, state: match.identity.state, stateFips: fips, placeFips: match.placeFips, censusName: match.identity.censusName, geographySchema: 'census-place.v1', population: pop, medianIncome: inc, medianHomeValue: home, vacancyPct, source: vintage.source, asOf: vintage.asOf, census: censusMetadata(vintage, new Date().toISOString()) };
  await setKeyEx(cacheKey, base, 30 * 24 * 3600);
  const canonicalCacheKey = cityCacheKey(fips, base.name, vintage);
  // A qualified selection must not pre-answer an ambiguous unqualified name.
  const canonicalMatch = matchCensusPlace(rows, base.name, fips);
  if (canonicalCacheKey !== cacheKey && canonicalMatch.found && canonicalMatch.placeFips === base.placeFips) await setKeyEx(canonicalCacheKey, base, 30 * 24 * 3600);
  return base;
}

// Attach the server-side Cividian Score to a found base record. Live layers run
// inside a hard budget; anything that misses stays pending, never invented.
// One mapping preserves existing API fields while adding the canonical
// decision. `layers` is a numeric compatibility alias for older home clients.
export function applyCityScore(d, s, live = {}) {
  return Object.assign(d, {
    score: s.score, scoreLayers: s.layers, layers: s.layers,
    layerStatus: s.layerStatus, scoreProvenance: s.provenance,
    scoreWeights: s.weights, liveWeightShare: s.liveWeightShare,
    verdict: s.verdict, scoreNote: s.scoreNote, decision: s.decision,
    accessSignals: s.layers.access != null ? (live.access?.signals || null) : null,
    activitySignals: s.layers.activity != null ? (live.activity?.signals || null) : null,
  });
}

export async function scoreCity(d, { lat, lon, readLayers = liveLayers } = {}) {
  if (!d || !d.found) return d;
  let timeout;
  try {
    const lv = (await Promise.race([
      readLayers({ name: d.name, state: d.state, lat, lon, stateFips: d.stateFips, placeFips: d.placeFips, population: d.population, budgetMs: 9000 }),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 15000); }),
    ])) || {};
    applyCityScore(d, computeScore(d, lv), lv);
  } catch (e) {
    applyCityScore(d, computeScore(d, null));
  } finally {
    clearTimeout(timeout);
  }
  return d;
}

// Monthly observation snapshot: the first served read of a place each month
// freezes what was believed at that moment (fundamentals, score, layer
// statuses) into an append-only record. This is what makes temporal drift and
// score calibration measurable a year from now. Write-once per place per
// month: a snapshot is never updated, corrected, or overwritten, because the
// point is knowing what the system said BEFORE the outcome arrived. Derived
// entirely from public-domain sources, so the envelope marks it training
// eligible, unlike every private user store.
//
// This lives beside the read rather than in api/city.js, where it started,
// because the versioned public API and the MCP server serve the same reads. A
// snapshot writer that only ran on the browser route would quietly stop
// building history the moment machine traffic became the majority of reads,
// and score history is the one asset here that cannot be backfilled later.
export async function snapshotCity(d) {
  try {
    if (!d || !d.found || d.score == null || !d.stateFips || !d.name) return;
    const month = new Date().toISOString().slice(0, 7);
    // Canonical, punctuation-blind, and shared with the reader. See obsPlaceKey.
    const place = obsPlaceKey(d.name);
    if (!place) return;
    const okey = 'pago:obs:' + d.stateFips + ':' + place + ':' + month;
    // Write-once per month was too blunt once every surface began freezing. A
    // crawler hitting the public city page, an MCP city_read with no
    // coordinates, or entity resolution could all land first, freeze a read
    // whose Access layer never resolved, and then REFUSE the browser read ten
    // minutes later that resolved it. The month held 61 forever, next month held
    // 66, and lib/brief.js reported a +5 score move as market movement when
    // nothing about the place had changed.
    //
    // So: a month is frozen at the BEST-RESOLVED read seen in that month, and
    // never downgraded. The point of the store is knowing what the system said
    // before the outcome arrived, and what it said is its best read, not
    // whichever caller happened to arrive first with the least context.
    const prior = await getKey(okey);
    if (prior && (prior.asOf !== d.asOf || prior.scoreModelVersion !== (d.decision?.modelVersion ?? null) || (prior.liveWeightShare || 0) >= (d.liveWeightShare || 0))) return;
    await setKey(okey, {
      schema: 'cityobs.v1',
      comparisonSignature: cityReadingSignature(d),
      place, name: d.name, state: d.state,
      stateFips: d.stateFips, placeFips: d.placeFips || null,
      month, ts: Date.now(),
      population: d.population, medianIncome: d.medianIncome,
      medianHomeValue: d.medianHomeValue, vacancyPct: d.vacancyPct,
      score: d.score, verdict: d.verdict ? d.verdict.tag : null,
      decisionSchema: d.decision?.schema || null,
      scoreModelVersion: d.decision?.modelVersion || null,
      liveWeightShare: d.liveWeightShare,
      layers: d.scoreLayers || null, layerStatus: d.layerStatus || null,
      source: d.source, asOf: d.asOf, census: d.census || null,
      meta: { owner: 'platform', source: 'served_city_read', visibility: 'internal', confidentiality: 'standard', trainingEligible: true, retention: 'permanent', updated: Date.now() },
    });
    // Index the month once. An upgrade within the same month rewrites the
    // observation but must not push a duplicate month onto the list.
    if (!prior) { try { await multiPush([['RPUSH', 'pago:obs:idx:' + d.stateFips + ':' + place, month]]); } catch (e) {} }
  } catch (e) {}
}

// Full read: base (cache-first + optional live) then score. This is the exact
// record /api/city returns, the public city page renders, and the versioned
// API and MCP server serve. Every served read freezes its month.
export async function getCity(name, st, opts = {}) {
  const base = await readCityBase(name, st, opts);
  if (!base || !base.found) return base;
  const scored = await scoreCity(base, opts);
  await snapshotCity(scored);
  return scored;
}
