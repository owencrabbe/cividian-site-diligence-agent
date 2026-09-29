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
import { gradePlace } from './grade.js';
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
  const name = legalName.replace(/ (?:city and borough|city and county|unified government|consolidated government|metropolitan government|metro government|urban county)(?: \(balance\))?$| (?:city|town|village|borough|municipality|CDP|comunidad|zona urbana)(?: \(balance\))?$| \(balance\)$/, '').trim();
  if (!name || !resolveStateFips(state)) return null;
  return { name, legalName, state, censusName };
}
function matchesIdentity(identity, query) {
  const wanted = normalizePlace(query);
  return wanted && [identity.name, identity.legalName, identity.censusName].some(value => normalizePlace(value) === wanted);
}

// Common names the Census does not use as the legal name. Consolidated
// city-counties carry both halves ("Nashville-Davidson", "Louisville/Jefferson
// County"), a few carry a second name in parentheses ("San Buenaventura
// (Ventura)"), and two large cities have a legal name nobody searches for.
// Used only when no place matches the query exactly, so "Athens" never
// displaces a real "Athens city".
const COMMON_NAME = { '16': { boise: 'boise city' }, '15': { honolulu: 'urban honolulu' } };
function commonNames(identity) {
  const out = new Set([normalizePlace(identity.name)]);
  const paren = identity.name.match(/^(.*?) \((.+)\)$/);
  if (paren) { out.add(normalizePlace(paren[1])); out.add(normalizePlace(paren[2])); }
  const first = identity.name.split(/[-/]/)[0].trim();
  if (first && first !== identity.name) out.add(normalizePlace(first));
  return out;
}
function matchesCommonName(identity, query, stateFips) {
  const wanted = normalizePlace(query);
  if (!wanted) return false;
  if (commonNames(identity).has(wanted)) return true;
  const alias = COMMON_NAME[stateFips] && COMMON_NAME[stateFips][wanted];
  return !!alias && normalizePlace(identity.name) === alias;
}

// Exact normalized identity matching, never a prefix ranking. If two legal
// places share a name, require the caller to choose a geographic qualifier.
export function matchCensusPlace(rows, queryName, stateFips) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) return { found: false, error: 'census error' };
  const header = rows[0], nameIndex = header.indexOf('NAME'), stateIndex = header.indexOf('state'), placeIndex = header.indexOf('place');
  if (nameIndex < 0 || stateIndex < 0 || placeIndex < 0) return { found: false, error: 'census error' };
  let matches = [];
  const candidates = [];
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || row[stateIndex] !== stateFips || !/^\d{5}$/.test(row[placeIndex])) continue;
    const identity = censusIdentity(row[nameIndex]);
    if (!identity || resolveStateFips(identity.state) !== stateFips) continue;
    candidates.push({ row, identity, stateFips, placeFips: row[placeIndex] });
    if (matchesIdentity(identity, queryName)) matches.push(candidates[candidates.length - 1]);
  }
  let byCommonName = false;
  if (!matches.length) { matches = candidates.filter(c => matchesCommonName(c.identity, queryName, stateFips)); byCommonName = matches.length > 0; }
  if (!matches.length) return { found: false, error: 'place not found' };
  if (byCommonName && matches.length === 1) return { found: true, ...matches[0], matchedBy: 'common_name' };
  if (matches.length > 1) {
    // Two legal places can share a name ("Marion city" and "Marion CDP" in
    // Indiana). A plain "Marion, IN" means the incorporated place: a city,
    // town or village outranks a Census-designated place, then the larger
    // population wins. The choice is deterministic and the others are named,
    // so the reader sees which place was read and what else shares the name.
    const popIndex = header.indexOf('B01003_001E');
    const unincorporated = m => /(?: CDP| comunidad| zona urbana)$/.test(m.identity.legalName) ? 1 : 0;
    const pop = m => { const n = popIndex >= 0 ? parseInt(m.row[popIndex], 10) : NaN; return Number.isFinite(n) && n > 0 ? n : 0; };
    const ranked = matches.slice().sort((a, b) => unincorporated(a) - unincorporated(b) || pop(b) - pop(a) || a.placeFips.localeCompare(b.placeFips));
    const [chosen, ...others] = ranked;
    return { found: true, ...chosen, ...(byCommonName ? { matchedBy: 'common_name' } : {}), disambiguation: { rule: 'incorporated_then_population', chose: chosen.identity.censusName, alternates: others.map(({ identity, placeFips }) => ({ censusName: identity.censusName, placeFips, stateFips })) } };
  }
  return { found: true, ...matches[0] };
}

export function verifiedCityIdentity(base, queryName, stateFips) {
  if (!base?.found || base.geographySchema !== 'census-place.v1' || base.stateFips !== stateFips || !/^\d{5}$/.test(base.placeFips)) return false;
  const identity = censusIdentity(base.censusName);
  return !!identity && resolveStateFips(identity.state) === stateFips && normalizePlace(base.name) === normalizePlace(identity.name) && (matchesIdentity(identity, queryName) || matchesCommonName(identity, queryName, stateFips));
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
  const key = process.env.CENSUS_API_KEY || process.env.Census_data || process.env.CENSUS_DATA || process.env.CENSUS_KEY;
  if (cached) {
    // Rows cached before the county fill existed still carry suppressed
    // medians. Fill them once, mark the attempt, and keep the cache warm.
    if (allowLive && key && !cached.countyFillAttempted && FALLBACK_FIELDS.some(([f]) => cached[f] == null)) {
      const { cached: _c, cacheCompatibility: _cc, ...row } = cached;
      await fillFromCounty(row, { key, vintage, fips });
      row.countyFillAttempted = true;
      await setKeyEx(cacheKey, row, 30 * 24 * 3600);
      return { ...row, cached: true };
    }
    return cached;
  }

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
  const base = { found: true, name: match.identity.name, state: match.identity.state, stateFips: fips, placeFips: match.placeFips, censusName: match.identity.censusName, geographySchema: 'census-place.v1', population: pop, medianIncome: inc, medianHomeValue: home, vacancyPct, source: vintage.source, asOf: vintage.asOf, census: censusMetadata(vintage, new Date().toISOString()), ...(match.disambiguation ? { alsoNamed: match.disambiguation.alternates.map(a => a.censusName), disambiguation: match.disambiguation.rule } : {}) };
  await fillFromCounty(base, { key, vintage, fips });
  base.countyFillAttempted = true;
  await setKeyEx(cacheKey, base, 30 * 24 * 3600);
  const canonicalCacheKey = cityCacheKey(fips, base.name, vintage);
  // A qualified selection must not pre-answer an ambiguous unqualified name.
  const canonicalMatch = matchCensusPlace(rows, base.name, fips);
  if (canonicalCacheKey !== cacheKey && canonicalMatch.found && canonicalMatch.placeFips === base.placeFips) await setKeyEx(canonicalCacheKey, base, 30 * 24 * 3600);
  return base;
}

// The Census suppresses medians for many small places (about one in ten).
// Rather than show "Pending", read the same tables for the county that holds
// the place and say so: each borrowed field is listed in estimateScope and
// named in fallbackNote, so no county figure is ever presented as the town's.
const FALLBACK_FIELDS = [['medianIncome', 'B19013_001E', 'Median household income'], ['medianHomeValue', 'B25077_001E', 'Median home value'], ['vacancyPct', null, 'Housing vacancy']];
export async function fillFromCounty(base, { key, vintage, fips, fetchJson } = {}) {
  const missing = FALLBACK_FIELDS.filter(([f]) => base[f] == null);
  if (!missing.length || !key || !/^\d{5}$/.test(base.placeFips || '')) return base;
  const get = fetchJson || (async (url) => { const r = await fetchWithTimeout(url, 8000); if (!r.ok) throw new Error('census ' + r.status); return r.json(); });
  try {
    const vars = 'NAME,B01003_001E,B19013_001E,B25077_001E,B25002_001E,B25002_003E';
    // Which county holds the place (the part with the most residents when a
    // place crosses a county line).
    const parts = await get(vintage.apiBase + '?get=NAME,B01003_001E&for=' + encodeURIComponent('county (or part)') + ':*&in=' + encodeURIComponent('state:' + fips + ' place:' + base.placeFips) + '&key=' + encodeURIComponent(key));
    if (!Array.isArray(parts) || parts.length < 2) return base;
    const h = parts[0], ci = h.indexOf('county (or part)') >= 0 ? h.indexOf('county (or part)') : h.indexOf('county'), pi = h.indexOf('B01003_001E');
    const top = parts.slice(1).sort((a, b) => (parseInt(b[pi], 10) || 0) - (parseInt(a[pi], 10) || 0))[0];
    const county = top && /^\d{3}$/.test(top[ci]) ? top[ci] : null;
    if (!county) return base;
    const rows = await get(vintage.apiBase + '?get=' + vars + '&for=county:' + county + '&in=state:' + fips + '&key=' + encodeURIComponent(key));
    if (!Array.isArray(rows) || rows.length < 2) return base;
    const row = rows[1], hdr = rows[0], at = (v) => { const n = parseInt(row[hdr.indexOf(v)], 10); return Number.isFinite(n) && n >= 0 ? n : null; };
    const countyName = String(row[hdr.indexOf('NAME')] || 'the county');
    const values = { medianIncome: at('B19013_001E'), medianHomeValue: at('B25077_001E'), vacancyPct: at('B25002_001E') && at('B25002_003E') != null ? Math.round(at('B25002_003E') / at('B25002_001E') * 1000) / 10 : null };
    const used = [];
    base.estimateScope = base.estimateScope || {};
    for (const [field, , label] of missing) {
      if (values[field] == null) continue;
      base[field] = values[field]; base.estimateScope[field] = { scope: 'county', name: countyName, geoid: fips + county }; used.push(label);
    }
    if (used.length) base.fallbackNote = used.join(', ') + (used.length === 1 ? ' is ' : ' are ') + countyName + "'s figure" + (used.length === 1 ? '' : 's') + ': the Census does not publish ' + (used.length === 1 ? 'it' : 'them') + ' for ' + (base.censusName || base.name) + ', a place too small for a reliable estimate.';
  } catch { /* the place's own nulls stand */ }
  return base;
}

// Attach the server-side Cividian Score to a found base record. Live layers run
// inside a hard budget; anything that misses stays pending, never invented.
// One mapping preserves existing API fields while adding the canonical
// decision. `layers` is a numeric compatibility alias for older home clients.
// The PURSUE/WATCH/PASS band on the development signal is withheld: it has
// never been calibrated (Gary and Fishers landed one point apart), and the
// economic grade is the ranked, sourced read. The number stays as a labeled
// development signal; the band returns only after a published backtest.
// Customer copy follows the coming-soon rule (lib/coming-soon.js): what is not
// offered yet says so, and the reason stays here in the source.
export const VERDICT_WITHHELD = Object.freeze({ tag: null, withheld: 'uncalibrated', note: 'Pursue, watch and pass bands: coming soon. The economic grade is the ranked read against similar-size peers; the development signal is a screen for comparing places you are already weighing.' });
export function withholdVerdict(decision) {
  if (!decision || typeof decision !== 'object') return decision;
  const interpretation = decision.interpretation ? { ...decision.interpretation, band: null, bandLabel: 'Band withheld', note: VERDICT_WITHHELD.note } : decision.interpretation;
  return { ...decision, verdict: VERDICT_WITHHELD, interpretation };
}
export function applyCityScore(d, s, live = {}) {
  return Object.assign(d, {
    score: s.score, scoreLayers: s.layers, layers: s.layers,
    layerStatus: s.layerStatus, scoreProvenance: s.provenance,
    scoreWeights: s.weights, liveWeightShare: s.liveWeightShare,
    verdict: s.score == null ? s.verdict : VERDICT_WITHHELD, scoreNote: s.scoreNote, decision: s.score == null ? s.decision : withholdVerdict(s.decision),
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
      grade: d.grade && d.grade.grade ? { grade: d.grade.grade, percentile: d.grade.percentile, model: d.grade.model, peerGroup: d.grade.peerGroup ? d.grade.peerGroup.label : null } : null,
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
  const [scored, grade] = await Promise.all([scoreCity(base, opts), gradePlace(base).catch(() => null)]);
  // The economic grade is the headline; the Cividian Score stays underneath
  // as the development signal and keeps writing its monthly history.
  if (grade) scored.grade = grade;
  await snapshotCity(scored);
  return scored;
}
