// lib/geo-uk.js
// The UK geography spine. This is the parallel of lib/fips.js plus the place
// resolution in lib/citydata.js, and it is deliberately NOT unified with them.
//
// The US model is state FIPS, county, place, tract. None of those exist here.
// The UK model is UPRN (the atomic property), USRN (the street), title number,
// postcode, and the ONS census and administrative hierarchy. Forcing UK
// identifiers into US shapes would produce a resolver that is wrong in both
// countries, so region is a routing decision made at the endpoint layer and
// the two resolvers never touch.
//
// Sources, all free and all keyless, verified live 2026-08-10:
//   postcodes.io            ONS Postcode Directory, postcode and point lookups
//   planning.data.gov.uk    local planning authority geography and organisation
//   OS Open UPRN / USRN     ingested in bulk, read from Redis, never per request
//
// The UPRN roll is the one part that cannot be resolved live. OS Open UPRN is a
// 618 MB CSV and OS Open USRN a 297 MB GeoPackage (versions verified 2026-08),
// so they are ingest-once assets. When the ingest has not been run, the roll
// resolves to no_coverage naming the product and the ingest script. It never
// resolves to an empty array presented as "no properties here", which on a
// street of forty buildings would be the same lie as a missing listed building.

import { getKey, setKeyEx } from './redis.js';

const TIMEOUT_MS = 7000;
const DAY = 24 * 3600;
// Postcode centroids and administrative geography move at most once a year and
// usually never. The ONS Postcode Directory is quarterly.
const GEO_TTL = 30 * DAY;
// A failed read retries within hours rather than being pinned for a month.
const GEO_MISS_TTL = 6 * 3600;

// Every UK response says which country it describes, because five of the
// sources this platform reads are England only or England and Wales only and a
// silent "UK" would be a claim none of them support.
export const REGION = 'uk';

// England is the shipped country. Wales has HM Land Registry Price Paid and EPC
// coverage but no planning.data.gov.uk, no Historic England and no English
// indices of deprivation, so a Welsh answer would be missing most of the block
// model. Scotland and Northern Ireland share nothing but the currency: Registers
// of Scotland, a separate EPC register, and separate planning systems. Saying so
// is cheaper and more useful than returning an England-shaped object with six
// null layers in it.
const SUPPORTED_COUNTRY = 'England';
const COUNTRY_NOTES = {
  Wales: 'HM Land Registry Price Paid and the EPC register do extend to Wales, but planning.data.gov.uk, the National Heritage List for England and the English indices of deprivation do not, so most of the block model would be absent. Cadw and DataMapWales would need to be wired first.',
  Scotland: 'Land ownership sits with Registers of Scotland, energy certificates with the Scottish EPC Register, and designations with Historic Environment Scotland, none of which are the sources this build reads.',
  'Northern Ireland': 'Land and Property Services holds the register and the valuation list, and planning runs under separate arrangements.',
  'Channel Islands': 'The Channel Islands sit outside the United Kingdom data estate entirely.',
  'Isle of Man': 'The Isle of Man sits outside the United Kingdom data estate entirely.',
};

async function getJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Cividian/1.0 (contact: ' + (process.env.CONTACT_EMAIL || 'contact@cividian.com') + ')' },
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ok: r.ok, json: j, snippet: txt.slice(0, 160) };
  } catch (e) {
    return { status: 0, ok: false, json: null, snippet: 'err: ' + String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

// Cache hits live long, misses live hours. Same contract as memo() in
// lib/layers.js: a provider outage degrades to an honest pending answer and is
// retried later, never converted into a value.
async function memo(key, ttl, producer) {
  try {
    const hit = await getKey(key);
    if (hit && hit.v !== undefined) return hit.v;
    if (hit && hit.miss) return null;
  } catch (e) {}
  let v = null;
  try { v = await producer(); } catch (e) { v = null; }
  try { await setKeyEx(key, v == null ? { miss: true } : { v: v }, v == null ? GEO_MISS_TTL : ttl); } catch (e) {}
  return v;
}

// ---------------------------------------------------------------------------
// Pure helpers. Exported so the suite can exercise every branch with zero env
// vars and zero network, which is the house condition for a green run.
// ---------------------------------------------------------------------------

// A UK postcode is outward code, space, inward code, where the inward code is
// always exactly three characters. Users paste them with no space, with two
// spaces, and in lower case. Normalizing here means the cache key is stable.
export function normalizePostcode(pc) {
  const raw = String(pc == null ? '' : pc).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length < 5 || raw.length > 7) return null;
  return raw.slice(0, raw.length - 3) + ' ' + raw.slice(raw.length - 3);
}

// A UPRN is numeric and up to 12 digits. Rejecting anything else here keeps a
// caller-supplied string out of a cache key and out of a query string.
export function normalizeUprn(uprn) {
  const s = String(uprn == null ? '' : uprn).trim();
  if (!/^[0-9]{1,12}$/.test(s)) return null;
  return String(Number(s));
}

// A USRN is numeric and up to 8 digits.
export function normalizeUsrn(usrn) {
  const s = String(usrn == null ? '' : usrn).trim();
  if (!/^[0-9]{1,8}$/.test(s)) return null;
  return String(Number(s));
}

// Returns null when the country is supported, or an honest refusal envelope
// naming the country when it is not. Never returns an empty English result for
// a Scottish or Welsh input: an empty result reads as "nothing here", and what
// is actually true is "this platform does not read the registers that country
// uses".
export function countryRefusal(country) {
  const c = String(country || '').trim();
  if (c === SUPPORTED_COUNTRY) return null;
  return {
    status: 'region_unsupported',
    region: REGION,
    country: c || null,
    note: c
      ? (c + ' is outside the coverage of this build. ' + (COUNTRY_NOTES[c] || 'The sources wired here are England only or England and Wales only.'))
      : 'The country for this location could not be established, so no coverage claim is made.',
  };
}

// Ray casting, winding-rule agnostic, for GeoJSON Polygon and MultiPolygon.
// Used to roll a hand-drawn block polygon into a UPRN list. Interior rings are
// honoured by toggling, which is correct for the simple non-self-intersecting
// polygons a user draws on a map.
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const straddles = (yi > lat) !== (yj > lat);
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(lon, lat, geom) {
  if (!geom || !geom.type || !Array.isArray(geom.coordinates)) return false;
  function poly(rings) {
    if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) if (pointInRing(lon, lat, rings[i])) return false;
    return true;
  }
  if (geom.type === 'Polygon') return poly(geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    for (let i = 0; i < geom.coordinates.length; i++) if (poly(geom.coordinates[i])) return true;
    return false;
  }
  return false;
}

// Bounding box of a polygon, used to fetch the smallest possible slice of the
// ingested UPRN index before the exact point-in-polygon test.
export function geometryBbox(geom) {
  if (!geom || !Array.isArray(geom.coordinates)) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity, seen = false;
  function walk(node) {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      seen = true;
      if (node[0] < minLon) minLon = node[0];
      if (node[0] > maxLon) maxLon = node[0];
      if (node[1] < minLat) minLat = node[1];
      if (node[1] > maxLat) maxLat = node[1];
      return;
    }
    for (let i = 0; i < node.length; i++) walk(node[i]);
  }
  walk(geom.coordinates);
  return seen ? { minLon: minLon, minLat: minLat, maxLon: maxLon, maxLat: maxLat } : null;
}

// Great-circle distance in kilometres. The absentee flag in lib/block-uk.js is
// derived from a registered office distance, so this has to be a real distance
// and not a bounding-box approximation.
export function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))) * 10) / 10;
}

// British National Grid (OSGB36, EPSG:27700) easting and northing to WGS84
// latitude and longitude.
//
// This exists because of a verified service bug, not for elegance. The Historic
// England NHLE feature service is native EPSG:27700, and asking it to reproject
// with outSR=4326 SILENTLY DROPS RECORDS: on a 120 m query at Whitefriargate it
// returns 44 features natively and 42 reprojected, and one of the two it drops
// is HULL TRINITY HOUSE, the only Grade I building on the block. The dropped
// records have perfectly ordinary geometry, so this is the service losing them
// in transformation rather than bad data. Reading native and converting here is
// the only way to see every listed building, and missing a Grade I is the worst
// single error this product could make.
//
// Inverse transverse Mercator onto the Airy 1830 ellipsoid, then a Helmert
// transform onto WGS84. Accurate to a few metres, which is well inside the
// capture scale of the source records.
const AIRY_A = 6377563.396;
const AIRY_B = 6356256.909;
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142;
// OSGB36 to WGS84 Helmert parameters. Translations in metres, rotations in
// seconds of arc, scale in parts per million.
const HELMERT = { tx: 446.448, ty: -125.157, tz: 542.06, rx: 0.1502, ry: 0.247, rz: 0.8421, s: -20.4894 };

export function bngToWgs84(easting, northing) {
  const E = Number(easting), N = Number(northing);
  if (!Number.isFinite(E) || !Number.isFinite(N)) return null;
  // Plausibility guard. The National Grid runs 0 to 700000 east and 0 to
  // 1300000 north; anything outside that is a lat/lon pair that reached the
  // wrong function, and converting it would produce a confident wrong point.
  if (E < 0 || E > 700000 || N < 0 || N > 1300000) return null;

  const a = AIRY_A, b = AIRY_B, F0 = 0.9996012717;
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0;
  for (let i = 0; i < 100; i++) {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dLat = lat - lat0, sLat = lat + lat0;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * dLat;
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dLat) * Math.cos(sLat);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const Md = (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    M = b * F0 * (Ma - Mb + Mc - Md);
    if (Math.abs(N - N0 - M) < 0.00001) break;
  }

  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const tanLat = Math.tan(lat), t2 = tanLat * tanLat, t4 = t2 * t2, t6 = t4 * t2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;
  const VII = tanLat / (2 * rho * nu);
  const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = tanLat / (720 * rho * nu5) * (61 + 90 * t2 + 45 * t4);
  const X = secLat / nu;
  const XI = secLat / (6 * nu3) * (nu / rho + 2 * t2);
  const XII = secLat / (120 * nu5) * (5 + 28 * t2 + 24 * t4);
  const XIIA = secLat / (5040 * nu7) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = E - E0, dE2 = dE * dE, dE3 = dE2 * dE, dE4 = dE2 * dE2, dE5 = dE3 * dE2, dE6 = dE4 * dE2, dE7 = dE5 * dE2;

  const latAiry = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  const lonAiry = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  // Airy 1830 geodetic to cartesian, Helmert to WGS84, back to geodetic.
  const eA2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const sA = Math.sin(latAiry), cA = Math.cos(latAiry);
  const vA = AIRY_A / Math.sqrt(1 - eA2 * sA * sA);
  const x1 = vA * cA * Math.cos(lonAiry);
  const y1 = vA * cA * Math.sin(lonAiry);
  const z1 = (1 - eA2) * vA * sA;

  const sec = Math.PI / 180 / 3600;
  const rx = HELMERT.rx * sec, ry = HELMERT.ry * sec, rz = HELMERT.rz * sec;
  const s1 = HELMERT.s / 1e6 + 1;
  const x2 = HELMERT.tx + x1 * s1 - y1 * rz + z1 * ry;
  const y2 = HELMERT.ty + x1 * rz + y1 * s1 - z1 * rx;
  const z2 = HELMERT.tz - x1 * ry + y1 * rx + z1 * s1;

  const eW2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - eW2)), vW = 0;
  for (let i = 0; i < 20; i++) {
    vW = WGS84_A / Math.sqrt(1 - eW2 * Math.sin(latW) * Math.sin(latW));
    const next = Math.atan2(z2 + eW2 * vW * Math.sin(latW), p);
    if (Math.abs(next - latW) < 1e-12) { latW = next; break; }
    latW = next;
  }
  const lonW = Math.atan2(y2, x2);
  return {
    lat: Math.round(latW * 180 / Math.PI * 1e6) / 1e6,
    lon: Math.round(lonW * 180 / Math.PI * 1e6) / 1e6,
  };
}

// Maps one postcodes.io result into the Cividian UK geography shape. Pure, so
// the suite exercises it against a pasted real response with no network.
// Every field is read from the payload or left null; nothing is defaulted.
export function normalizePostcodeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const codes = r.codes || {};
  const num = function (v) { const x = Number(v); return Number.isFinite(x) ? x : null; };
  return {
    postcode: r.postcode || null,
    country: r.country || null,
    lat: num(r.latitude),
    lon: num(r.longitude),
    easting: num(r.eastings),
    northing: num(r.northings),
    // LSOA 2021 is the deprivation unit for the English indices of deprivation
    // 2025 (33,755 LSOAs, the 2021 count). lsoa11 is carried alongside because
    // older series are still published on 2011 boundaries and a silent switch
    // between the two would misjoin every deprivation figure.
    lsoa: r.lsoa21 || r.lsoa || null,
    lsoaCode: codes.lsoa21 || codes.lsoa || null,
    lsoa11Code: codes.lsoa11 || null,
    msoa: r.msoa21 || r.msoa || null,
    msoaCode: codes.msoa21 || codes.msoa || null,
    oaCode: codes.oa21 || null,
    ward: r.admin_ward || null,
    wardCode: codes.admin_ward || null,
    lad: r.admin_district || null,
    ladCode: codes.admin_district || null,
    parish: r.parish || null,
    constituency: r.parliamentary_constituency_2024 || r.parliamentary_constituency || null,
    ttwa: r.ttwa || null,
    builtUpArea: r.bua || null,
    // The ONS Postcode Directory carries an IMD RANK, not a decile and not a
    // score. Publishing it as anything else would misstate what was read.
    imdRank: num(r.index_of_multiple_deprivation),
    provenance: 'ONS Postcode Directory via postcodes.io, read live. Open Government Licence v3.0.',
  };
}

// ---------------------------------------------------------------------------
// Live geography reads
// ---------------------------------------------------------------------------

async function postcodeLookup(pc) {
  return memo('pago:uk:pc:' + pc, GEO_TTL, async function () {
    const r = await getJSON('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc));
    if (!r.ok || !r.json || !r.json.result) return null;
    return normalizePostcodeRecord(r.json.result);
  });
}

async function pointLookup(lat, lon) {
  // Two decimal places is roughly 1.1 km, which is too coarse for a block; four
  // is about 11 m, which matches the parcel cache grid already in
  // lib/providers.js and keeps repeat map clicks free.
  const rl = Math.round(lat * 1e4) / 1e4;
  const rn = Math.round(lon * 1e4) / 1e4;
  return memo('pago:uk:pt:' + rl + ',' + rn, GEO_TTL, async function () {
    const r = await getJSON('https://api.postcodes.io/postcodes?lat=' + rl + '&lon=' + rn + '&limit=1&radius=1000');
    const arr = r.json && r.json.result;
    if (!r.ok || !Array.isArray(arr) || !arr.length) return null;
    return normalizePostcodeRecord(arr[0]);
  });
}

// The local planning authority is NOT always the local authority district, so
// it is resolved by its own geometry rather than assumed from the LAD. Verified
// at Whitefriargate: entity 626053, reference E60000053, "Kingston upon Hull,
// City of LPA".
async function lpaAtPoint(lat, lon) {
  const rl = Math.round(lat * 1e3) / 1e3;
  const rn = Math.round(lon * 1e3) / 1e3;
  return memo('pago:uk:lpa:' + rl + ',' + rn, GEO_TTL, async function () {
    const r = await getJSON('https://www.planning.data.gov.uk/entity.json?dataset=local-planning-authority'
      + '&latitude=' + rl + '&longitude=' + rn + '&limit=1');
    const e = r.json && Array.isArray(r.json.entities) && r.json.entities[0];
    if (!r.ok || !e) return null;
    return { name: e.name || null, reference: e.reference || null, entity: e.entity || null };
  });
}

// The full local-authority organisation list, 379 rows, fetched once and held
// for 30 days. This is the only way to get from an LPA reference to the
// ORGANISATION ENTITY that publishes datasets to planning.data.gov.uk, and that
// organisation entity is what the coverage check in lib/providers-uk.js keys on.
//
// Verified 2026-08-10: planning.data.gov.uk silently IGNORES unknown query
// filters rather than rejecting them. Asking for
// ?dataset=local-authority&statistical_geography=E06000010 returns all 379
// authorities, not one. Filtering therefore has to happen here, in code, and a
// future edit must not "optimise" it back into a query parameter that looks
// like it works and does not.
async function localAuthorityIndex() {
  return memo('pago:uk:la-index', GEO_TTL, async function () {
    const r = await getJSON('https://www.planning.data.gov.uk/entity.json?dataset=local-authority&limit=500', 8000);
    const rows = r.json && Array.isArray(r.json.entities) ? r.json.entities : null;
    if (!r.ok || !rows || !rows.length) return null;
    const byLpa = {};
    const byLad = {};
    rows.forEach(function (e) {
      const rec = {
        entity: e.entity || null,
        name: e.name || null,
        reference: e.reference || null,
        ladCode: e['local-authority-district'] || e['statistical-geography'] || null,
        lpaCode: e['local-planning-authority'] || null,
        website: e.website || null,
      };
      if (rec.lpaCode && !byLpa[rec.lpaCode]) byLpa[rec.lpaCode] = rec;
      if (rec.ladCode && !byLad[rec.ladCode]) byLad[rec.ladCode] = rec;
    });
    return { byLpa: byLpa, byLad: byLad, count: rows.length };
  });
}

// Resolve the publishing organisation for a place. Preference order is LPA code
// then LAD code, because the LPA is what actually publishes designation data.
export async function organisationFor(lpaCode, ladCode) {
  const idx = await localAuthorityIndex();
  if (!idx) return null;
  return (lpaCode && idx.byLpa[lpaCode]) || (ladCode && idx.byLad[ladCode]) || null;
}

// ---------------------------------------------------------------------------
// The ingested OS Open UPRN and OS Open USRN index
// ---------------------------------------------------------------------------

// Absent ingest is no_coverage, never an empty roll. The note names the exact
// product, the exact version verified live, and the script that loads it, so
// the gap reads as an operations task rather than as "this street has no
// buildings on it".
const UPRN_INGEST_NOTE =
  'OS Open UPRN has not been ingested in this environment, so the property roll for this geography is unknown rather than empty. '
  + 'Load it with scripts/ingest-os-open-uprn.mjs (OS Data Hub Downloads API, product OpenUPRN, version 2026-08, no API key required).';
const USRN_INGEST_NOTE =
  'OS Open USRN has not been ingested in this environment, so the street roll is unknown rather than empty. '
  + 'Load it with scripts/ingest-os-open-uprn.mjs (OS Data Hub Downloads API, product OpenUSRN, GeoPackage only, version 2026-08, no API key required).';

export async function uprnsForPostcode(pc) {
  try {
    const hit = await getKey('pago:uk:uprn:pc:' + pc);
    if (Array.isArray(hit) && hit.length) {
      return { status: 'covered', uprns: hit, note: 'OS Open UPRN, ingested bulk index. Contains OS data, Crown copyright and database right 2026.' };
    }
    // A postcode present in the index with an empty list is a real empty: the
    // ingest saw the postcode and it holds no addressable property. That is
    // distinct from the index being absent, and only the ingest can tell them
    // apart, so it writes the empty array deliberately.
    if (Array.isArray(hit)) {
      return { status: 'covered', uprns: [], note: 'OS Open UPRN holds no addressable property for this postcode. This is a real empty, read from the ingested index.' };
    }
  } catch (e) {}
  return { status: 'no_coverage', uprns: [], note: UPRN_INGEST_NOTE };
}

// ---------------------------------------------------------------------------
// The five public resolvers
// ---------------------------------------------------------------------------

function envelope(geo, lpa, org, uprnRoll) {
  return {
    status: 'covered',
    region: REGION,
    country: geo.country,
    // The flat shape the build brief specifies, so callers destructure it
    // directly rather than reaching through a nested object.
    uprns: uprnRoll.uprns,
    lsoa: geo.lsoaCode,
    msoa: geo.msoaCode,
    ward: geo.wardCode,
    lad: geo.ladCode,
    lpa: lpa ? lpa.reference : null,
    lat: geo.lat,
    lon: geo.lon,
    // Everything else hangs off named sub-objects so the flat keys above stay
    // stable if the detail grows.
    names: {
      lsoa: geo.lsoa, msoa: geo.msoa, ward: geo.ward, lad: geo.lad,
      lpa: lpa ? lpa.name : null, parish: geo.parish, constituency: geo.constituency,
      ttwa: geo.ttwa, builtUpArea: geo.builtUpArea,
    },
    codes: {
      postcode: geo.postcode, oa: geo.oaCode, lsoa21: geo.lsoaCode, lsoa11: geo.lsoa11Code,
      msoa21: geo.msoaCode, ward: geo.wardCode, lad: geo.ladCode,
      lpa: lpa ? lpa.reference : null, lpaEntity: lpa ? lpa.entity : null,
      // The organisation entity is the join key for every per-LPA coverage
      // check on planning.data.gov.uk. Without it the platform cannot tell
      // "this LPA published nothing" from "there is nothing here".
      organisationEntity: org ? org.entity : null,
      billingAuthority: null,
    },
    grid: { easting: geo.easting, northing: geo.northing },
    imdRank: geo.imdRank,
    uprnStatus: uprnRoll.status,
    uprnNote: uprnRoll.note,
    provenance: {
      geography: geo.provenance,
      lpa: lpa
        ? 'MHCLG Planning Data Platform, local-planning-authority dataset, read live. Open Government Licence v3.0.'
        : 'Local planning authority not resolved for this point. planning.data.gov.uk returned no LPA geometry covering it.',
      uprns: uprnRoll.note,
    },
    note: 'England. Geography resolved from the ONS Postcode Directory and the MHCLG Planning Data Platform.',
  };
}

function failed(reason, extra) {
  return Object.assign({
    status: 'error', region: REGION, country: null, uprns: [],
    lsoa: null, msoa: null, ward: null, lad: null, lpa: null, lat: null, lon: null,
    note: reason,
  }, extra || {});
}

export async function resolveByPostcode(postcode) {
  const pc = normalizePostcode(postcode);
  if (!pc) {
    return failed('That is not a recognisable UK postcode. Expected an outward code, a space, and a three character inward code.', { status: 'no_coverage' });
  }
  const geo = await postcodeLookup(pc);
  if (!geo) {
    return failed('The ONS Postcode Directory has no record for ' + pc + '. It may be a terminated postcode, or postcodes.io may be unreachable.', { status: 'no_coverage' });
  }
  const refusal = countryRefusal(geo.country);
  if (refusal) return Object.assign({ uprns: [], lat: geo.lat, lon: geo.lon, lad: geo.ladCode, lsoa: null, msoa: null, ward: null, lpa: null }, refusal);

  const [lpa, roll] = await Promise.all([
    geo.lat != null && geo.lon != null ? lpaAtPoint(geo.lat, geo.lon) : Promise.resolve(null),
    uprnsForPostcode(pc),
  ]);
  const org = await organisationFor(lpa && lpa.reference, geo.ladCode);
  return envelope(geo, lpa, org, roll);
}

export async function resolveByPoint(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
    return failed('A latitude and longitude are required, in decimal degrees.', { status: 'no_coverage' });
  }
  const geo = await pointLookup(la, lo);
  if (!geo) {
    return failed('No UK postcode was found within 1 km of that point. It may be offshore, or outside the United Kingdom.', { status: 'no_coverage' });
  }
  const refusal = countryRefusal(geo.country);
  if (refusal) return Object.assign({ uprns: [], lat: la, lon: lo, lad: geo.ladCode, lsoa: null, msoa: null, ward: null, lpa: null }, refusal);

  const [lpa, roll] = await Promise.all([lpaAtPoint(la, lo), uprnsForPostcode(geo.postcode)]);
  const org = await organisationFor(lpa && lpa.reference, geo.ladCode);
  const out = envelope(geo, lpa, org, roll);
  // The postcode centroid is not the queried point. Report both rather than
  // letting the centroid quietly replace the coordinate the user asked about.
  out.lat = la;
  out.lon = lo;
  out.codes.postcodeCentroid = { lat: geo.lat, lon: geo.lon };
  return out;
}

export async function resolveByUprn(uprn) {
  const u = normalizeUprn(uprn);
  if (!u) return failed('A UPRN is up to twelve digits and numeric.', { status: 'no_coverage' });

  let rec = null;
  try { rec = await getKey('pago:uk:uprn:' + u); } catch (e) {}
  if (!rec || rec.lat == null || rec.lon == null) {
    return failed(UPRN_INGEST_NOTE, { status: 'no_coverage', uprn: u });
  }
  const out = await resolveByPoint(rec.lat, rec.lon);
  out.uprn = u;
  out.property = {
    uprn: u,
    lat: rec.lat,
    lon: rec.lon,
    easting: rec.easting != null ? rec.easting : null,
    northing: rec.northing != null ? rec.northing : null,
    usrn: rec.usrn != null ? String(rec.usrn) : null,
    postcode: rec.postcode || (out.codes && out.codes.postcode) || null,
    provenance: 'OS Open UPRN, ingested bulk index, version ' + (rec.version || 'unrecorded') + '. Contains OS data, Crown copyright and database right 2026.',
  };
  return out;
}

// The ordered UPRN roll for a street. Order matters: a user assembling a block
// wants the buildings in the order they walk past them, not in UPRN order, so
// the ingest stores the roll already sorted along the street geometry and this
// preserves that order rather than re-sorting numerically.
export async function blockFromUsrn(usrn) {
  const s = normalizeUsrn(usrn);
  if (!s) return { status: 'no_coverage', region: REGION, usrn: null, uprns: [], note: 'A USRN is up to eight digits and numeric.' };
  let rec = null;
  try { rec = await getKey('pago:uk:usrn:' + s); } catch (e) {}
  if (!rec || !Array.isArray(rec.uprns)) {
    return { status: 'no_coverage', region: REGION, usrn: s, uprns: [], note: USRN_INGEST_NOTE };
  }
  return {
    status: 'covered',
    region: REGION,
    usrn: s,
    name: rec.name || null,
    uprns: rec.uprns,
    count: rec.uprns.length,
    geometry: rec.geometry || null,
    note: 'OS Open USRN street extent with the OS Open UPRN properties addressed to it, ingested bulk index. Contains OS data, Crown copyright and database right 2026.',
  };
}

// Every UPRN whose point falls inside a drawn polygon. The bounding box narrows
// the candidate set to the postcode sectors the polygon touches; the exact test
// is then point in polygon on each candidate.
export async function blockFromPolygon(geojson) {
  const geom = geojson && geojson.type === 'Feature' ? geojson.geometry : geojson;
  const bbox = geometryBbox(geom);
  if (!bbox) {
    return { status: 'no_coverage', region: REGION, uprns: [], note: 'A GeoJSON Polygon or MultiPolygon is required.' };
  }
  // Guard the cost before touching the index. A polygon spanning half of
  // England is a mis-drawn shape, not a block, and rolling it would be a very
  // expensive way to answer a question nobody asked.
  const spanLat = bbox.maxLat - bbox.minLat;
  const spanLon = bbox.maxLon - bbox.minLon;
  if (spanLat > 0.2 || spanLon > 0.3) {
    return {
      status: 'no_coverage', region: REGION, uprns: [],
      note: 'That polygon spans more than about 20 km. The block roll is built for a street or a town centre island, not a district. Draw a smaller shape.',
    };
  }
  // Read every tile the bounding box touches, not one key built from the box.
  // The ingest writes tiles on a fixed 0.1 degree lattice keyed lon,lat; a key
  // derived from the box corners would name a tile that was never written, so
  // every polygon roll would report no_coverage and the failure would look like
  // a missing ingest rather than a key mismatch. The lattice has to be shared
  // between the writer and this reader, which is why tilesFor is exported and
  // the suite asserts a known box against a known tile list.
  const tiles = tilesFor(bbox);
  const slices = await Promise.all(tiles.map(async function (t) {
    try { return await getKey('pago:uk:uprn:bbox:' + t); } catch (e) { return null; }
  }));
  const present = slices.filter(function (s) { return Array.isArray(s); });
  if (!present.length) {
    return { status: 'no_coverage', region: REGION, uprns: [], tiles: tiles, note: UPRN_INGEST_NOTE };
  }
  const index = present.flat();
  const inside = index.filter(function (p) { return pointInGeometry(p.lon, p.lat, geom); });
  // A polygon that straddles the edge of the ingested area reads some tiles and
  // misses others. Reporting the roll as complete would understate it silently,
  // so the partial case is named.
  const partial = present.length < tiles.length;
  return {
    status: partial ? 'no_coverage' : 'covered',
    region: REGION,
    uprns: inside,
    count: inside.length,
    candidates: index.length,
    tiles: tiles.length,
    tilesRead: present.length,
    note: partial
      ? ('Only ' + present.length + ' of the ' + tiles.length + ' index tiles this polygon touches have been ingested, so the roll is incomplete and is reported as no_coverage rather than as ' + inside.length + ' properties. ' + UPRN_INGEST_NOTE)
      : ('OS Open UPRN points tested against the drawn polygon. ' + inside.length + ' of ' + index.length
        + ' candidates in the surrounding tiles fall inside. Contains OS data, Crown copyright and database right 2026.'),
  };
}

// The 0.1 degree tile lattice, shared with scripts/ingest-os-open-uprn.mjs.
// One tile at English latitudes is roughly 11 km north to south and 7 km east
// to west, so a town centre block reads one tile and a high street that
// straddles a lattice line reads two.
export function tileKey(lat, lon) {
  return (Math.round(lon * 10) / 10) + ',' + (Math.round(lat * 10) / 10);
}

export function tilesFor(bbox) {
  const out = [];
  const seen = {};
  // Step by half a tile so a box narrower than one tile still produces the
  // tiles its corners fall in, and pad by one tile each way because a point
  // near a lattice edge rounds into the neighbouring tile.
  for (let lon = bbox.minLon - 0.1; lon <= bbox.maxLon + 0.1; lon += 0.05) {
    for (let lat = bbox.minLat - 0.1; lat <= bbox.maxLat + 0.1; lat += 0.05) {
      const k = tileKey(lat, lon);
      if (!seen[k]) { seen[k] = true; out.push(k); }
    }
  }
  return out;
}
