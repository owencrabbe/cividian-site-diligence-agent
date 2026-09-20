// Provider-agnostic data layer for Cividian.
//
// Parcels and zoning come from interchangeable vendor adapters that each
// normalize into ONE Cividian schema. The frontend (and any future Cividian public
// API) talks only to Cividian, never to a vendor. Swapping Regrid for Zoneomics,
// or adding Gridics, is a config change here, not a rewrite anywhere else.
//
// Coverage is reported honestly. A vendor that authenticates but returns no
// data for a county is "no_coverage", not an error and never silently faked.
// This is the gap behind the empty Muncie map: the Regrid plan currently
// licenses only some counties. Cividian now says so instead of hiding it.
//
// ReportAll USA (added 2026-07-12) is a second commercial source with 99%+
// nationwide coverage across 3,229 counties, so it is tried FIRST in the
// provider chain below; Regrid and IndianaMap remain as fallbacks if a
// ReportAll query errors or returns no_coverage for a point.

import { getKey, setKeyEx } from './redis.js';

const TIMEOUT_MS = 8000;
// Parcel layers move slowly (assessments update at most yearly). Cache a
// covered read for 6h so re-clicks, re-renders, and pans back over the same
// area are free instead of re-spending paid ReportAll/Regrid quota. A
// no_coverage answer is cached briefly so an unlicensed county is not
// re-queried on every interaction; no_key/error are never cached (config may
// change, and an error should retry).
const PARCEL_TTL = 6 * 3600;
const PARCEL_MISS_TTL = 3600;

async function getJSON(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ok: r.ok, json: j, snippet: txt.slice(0, 160) };
  } catch (e) {
    return { status: 0, ok: false, json: null, snippet: 'err: ' + String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

function env(/* names */) {
  for (let i = 0; i < arguments.length; i++) {
    const v = process.env[arguments[i]];
    if (v) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PARCEL PROVIDERS
// Each adapter resolves to { status:'covered'|'no_coverage'|'no_key'|'error',
//                            features:[GeoJSON Feature], note }
// ---------------------------------------------------------------------------

export function normalizeParcel(f) {
  const p = f.properties || {};
  const fl = p.fields || p;
  // Null, not a placeholder. A browser reader understands "Owner on record" as
  // an empty state; a machine caller parsing /api/v1/parcels receives a string
  // in the owner field and has no way to tell it from a name, so an
  // MCP-connected model reported the owner of a parcel as "Owner on record".
  // The sibling normalizer for ReportAll already returns null here, the frontend
  // already renders p.owner == null as "not in county feed", and the house rule
  // is that a value which cannot be verified is null with a reason, never a
  // default. A display fallback belongs in the view, not in the normalizer that
  // feeds the API.
  const addr = fl.address
    || [fl.saddno, fl.saddpref, fl.saddstr, fl.saddsttyp].filter(Boolean).join(' ').trim()
    || p.headline || null;
  const val = fl.parval || fl.improvval || fl.landval || fl.saleprice || null;
  const use = fl.usedesc || fl.lbcs_activity_desc || fl.zoning_description || fl.zoning || null;
  // Out-of-state owner: derived ONLY when the record carries both the situs
  // state and the owner's mailing state. Absent either, oos stays null (not
  // false), so "unknown" never renders as "local owner". This is owner data
  // and is gated with owner/value at the API layer.
  const situsState = String(fl.state2 || fl.stateabbrev || '').trim().toUpperCase() || null;
  const mailState = String(fl.mail_state2 || fl.mail_addresstate || fl.mail_state || '').trim().toUpperCase() || null;
  const oos = (situsState && mailState) ? (situsState !== mailState) : null;
  return {
    geometry: f.geometry,
    addr: addr,
    owner: fl.owner || null,
    use: use,
    zoning: fl.zoning || '',
    acre: fl.ll_gisacre || fl.gisacre || null,
    value: val,
    // The last recorded sale, where the plan publishes it. saleprice already
    // backs the value fallback above, so the field name is proven in this
    // tree; saledate is its sibling in the same Regrid schema. Absent either,
    // null: a sale that is not on record is never invented, and the
    // transactions surface treats a dateless price as no transaction.
    salePrice: (fl.saleprice != null) ? Number(fl.saleprice) : null,
    saleDate: fl.saledate || null,
    // Left null rather than guessed: Regrid's schema likely has a building
    // footprint field, but it is not verified against their live API in
    // this codebase (unlike ll_gisacre above, which is proven in
    // production). Wire it when confirmed against a real Regrid response;
    // ReportAll's bldg_sqft (verified against their published Data
    // Dictionary) is why Cividian is not blocked on this.
    bldgSqft: null,
    bldgFootprintSqft: null,
    yearBuilt: null,
    oos: oos,
    mailState: mailState
  };
}

// Redaction happens on the SERVER, before the response is serialized, because
// anything sent to an ungated caller is already theirs: a hidden field is one
// DevTools click from visible, and this product previously leaked live
// owner/value exactly that way. An ungated caller must never receive the
// bytes at all. Geometry, address, use, and zoning stay public so the map
// still renders for everyone.
//
// The five sensitive fields, matched field-for-field against the strip in
// api/parcels.js and verified as no more and no fewer: owner and value are
// the paid identity/assessment data, oos + mailState are derived from the
// owner's mailing address so they carry the same information, and salePrice
// is licensed value data of exactly the same kind as value.
export function redactParcel(parcel, allowSensitive) {
  if (allowSensitive) return Object.assign({}, parcel);
  return Object.assign({}, parcel, { owner: null, value: null, oos: null, mailState: null, salePrice: null });
}

// The vendor audit trail, made safe to publish. `tried` is a genuinely useful
// honesty artifact: it says which sources were asked and what each answered. Its
// `note` field, however, is vendor free text, and on the error branch
// the ReportAll adapter below forwards the vendor's own JSON message verbatim, which
// Cividian does not control and which vendors have historically used to echo
// submitted credentials back. The status vocabulary is fixed and already carries
// the whole meaning, so the note is rewritten from it and the vendor string is
// never served to a caller.
const TRIED_NOTES = {
  covered: "This vendor returned parcels for this point.",
  no_coverage: "This vendor authenticated but licenses no data at this point. That is a coverage answer, not a failure.",
  no_key: "This vendor is not configured in this environment.",
  error: "This vendor did not answer. The reason is recorded server side and is not forwarded.",
};
export function publicTried(tried) {
  return (Array.isArray(tried) ? tried : []).map((t) => ({
    provider: t.provider,
    status: t.status,
    count: typeof t.count === "number" ? t.count : 0,
    note: TRIED_NOTES[t.status] || "This vendor returned an unrecognized status.",
  }));
}

// Minimal OGC WKT -> GeoJSON geometry parser. ReportAll's Standard API
// returns geometry only as geom_as_wkt (never GeoJSON), so this bridges it
// into the same GeoJSON shape every other adapter and the frontend map
// already expect. Handles the two shapes ReportAll actually returns per its
// own docs: POLYGON((ring),(hole)) and MULTIPOLYGON(((ring)),((ring))), SRID
// 4326 (lon/lat) by request (si_srid/sn_srid=4326 on every ReportAll call
// below). Depth-aware, not regex-split-by-comma, so it survives parcels with
// interior rings (easements, ponds). No external WKT library added; parcel
// geometry is the only shape this needs to handle, and that budget does not
// justify a fourth runtime dependency.
function splitParenGroups(str) {
  const parts = []; let depth = 0, start = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (c === ')') { depth--; if (depth === 0) parts.push(str.slice(start, i)); }
  }
  return parts;
}
function stripOuterParen(str) {
  const t = str.trim();
  return (t[0] === '(' && t[t.length - 1] === ')') ? t.slice(1, -1) : t;
}
function parseRing(str) {
  return str.trim().split(',').map(function (pair) {
    const xy = pair.trim().split(/\s+/).map(Number);
    return [xy[0], xy[1]];
  });
}
export function wktToGeoJSON(wkt) {
  if (!wkt || typeof wkt !== 'string') return null;
  const s = wkt.trim();
  try {
    if (/^MULTIPOLYGON/i.test(s)) {
      const container = stripOuterParen(s.replace(/^MULTIPOLYGON\s*/i, ''));
      const polys = splitParenGroups(container).map(function (ringsListStr) {
        return splitParenGroups(ringsListStr).map(parseRing);
      });
      if (!polys.length || !polys[0].length) return null;
      return { type: 'MultiPolygon', coordinates: polys };
    }
    if (/^POLYGON/i.test(s)) {
      const ringsListStr = stripOuterParen(s.replace(/^POLYGON\s*/i, ''));
      const rings = splitParenGroups(ringsListStr).map(parseRing);
      if (!rings.length) return null;
      return { type: 'Polygon', coordinates: rings };
    }
  } catch (e) { return null; }
  return null;
}

// Spherical ring-area approximation for building footprint square footage.
// This intentionally mirrors app.html's ringAreaSqM/geomSqFt line for line;
// there is no shared frontend/backend util layer in this single-file-page
// architecture, so the two copies are kept in sync by hand. Used only when
// ReportAll returns real per-parcel building footprint polygons
// (buildings_poly, via return_buildings=true) but the scalar bldg_sqft
// assessor field is absent for that record, verified 2026-07-12 to be the
// common case: 13/13 sampled records across three counties in two states,
// including ReportAll's own documentation example address, came back with
// bldg_sqft null. Real per-parcel geometry still beats OSM's block-merged
// outline even when the exact assessor figure is not on file.
function ringAreaSqM(ring) {
  const R = 6378137; let a = 0;
  if (!ring || ring.length < 3) return 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
    a += (p2[0] - p1[0]) * Math.PI / 180 * (2 + Math.sin(p1[1] * Math.PI / 180) + Math.sin(p2[1] * Math.PI / 180));
  }
  return Math.abs(a * R * R / 2);
}
export function geomSqFt(geom) {
  if (!geom) return null;
  let sqm = 0;
  function poly(coords) { let s = ringAreaSqM(coords[0]); for (let i = 1; i < coords.length; i++) s -= ringAreaSqM(coords[i]); return Math.max(0, s); }
  if (geom.type === 'Polygon') sqm = poly(geom.coordinates);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(function (c) { sqm += poly(c); });
  else return null;
  return sqm > 0 ? sqm * 10.7639 : null;
}
// buildings_poly is an array of { geom_as_wkt } entries, one per structure
// on the parcel (ReportAll docs: "a new entry in results will be available
// for any records we have data for" when return_buildings=true). Sums area
// across all structures on the parcel; returns null (not 0) when the array
// is absent or every entry fails to parse, so an empty result never renders
// as "zero square feet".
function reportAllFootprintSqFt(rec) {
  const polys = rec && rec.buildings_poly;
  if (!polys || !Array.isArray(polys) || !polys.length) return null;
  let total = 0, any = false;
  polys.forEach(function (bp) {
    const g = wktToGeoJSON(bp && bp.geom_as_wkt);
    const sqft = geomSqFt(g);
    if (sqft != null) { total += sqft; any = true; }
  });
  return any ? Math.round(total) : null;
}

// Maps ReportAll's Standard API field names (see the published Standard API
// Data Dictionary, version 9) into the single Cividian parcel schema.
// Fields absent from a given record are omitted by ReportAll entirely
// (their docs: "attributes with empty values are omitted"), so every field
// read here already falls back to null on its own; nothing is guessed or
// defaulted to a neutral value.
export function normalizeReportAllRecord(rec) {
  const r = rec || {};
  const situsState = String(r.state_abbr || '').trim().toUpperCase() || null;
  const mailState = String(r.mail_statename || '').trim().toUpperCase() || null;
  const acre = (r.acreage_calc != null) ? r.acreage_calc : (r.acreage != null ? r.acreage : null);
  return {
    geometry: wktToGeoJSON(r.geom_as_wkt),
    addr: r.address || ('Parcel ' + (r.parcel_id || 'on record')),
    owner: r.owner || null,
    use: r.land_use_class || r.land_use_code || 'Unknown',
    zoning: r.zoning || '',
    acre: acre,
    value: (r.mkt_val_tot != null) ? r.mkt_val_tot : null,
    // ReportAll's dictionary lists transaction fields, but none is verified
    // against a live response in this codebase, so they stay null here until
    // they are. Same rule as bldgFootprintSqft below: verified or absent.
    salePrice: null,
    saleDate: null,
    // Real assessor building square footage, per parcel. This is the fix for
    // the shared-shape problem: the frontend's OSM-derived building outline
    // estimate (buildingAt/geomSqFt in app.html) merges adjacent storefronts
    // into one polygon in dense blocks, so distinct addresses were reading
    // the same footprint. bldg_sqft is per-PARCEL assessor data and takes
    // priority over that estimate wherever it is present. Not gated (like
    // acre/use/zoning): building size is public assessor record, not owner
    // or value data.
    bldgSqft: (r.bldg_sqft != null) ? Number(r.bldg_sqft) : null,
    // Computed from real per-parcel building footprint geometry, not the
    // assessor's own figure. Kept separate from bldgSqft above so the UI
    // never presents a geometric estimate as an exact assessor record.
    bldgFootprintSqft: reportAllFootprintSqFt(r),
    yearBuilt: (r.year_built != null) ? Number(r.year_built) : null,
    oos: (situsState && mailState) ? (situsState !== mailState) : null,
    mailState: mailState,
    source: 'ReportAll USA' + (r.last_updated ? (' (updated ' + r.last_updated + ')') : '')
  };
}

// ReportAll's "nearest parcel" query (spatial_nearest) returns parcels in
// increasing order of distance from the point, capped by rpp/page; it has
// no radius parameter, unlike Regrid's point+radius call. rpp is capped at
// 50 here (below ReportAll's own default) to protect quota on a paid plan;
// Cividian already re-clamps limit in fetchParcels below.
async function reportallParcels(o) {
  const KEY = env('reportall', 'REPORTALL', 'REPORTALL_API_KEY', 'REPORTALL_CLIENT_KEY');
  if (!KEY) return { status: 'no_key', features: [], note: 'ReportAll client key not set' };
  const rpp = Math.max(1, Math.min(o.limit, 50));
  const url = 'https://reportallusa.com/api/parcels'
    + '?client=' + encodeURIComponent(KEY)
    + '&v=9&spatial_nearest=' + encodeURIComponent('POINT(' + o.lon + ' ' + o.lat + ')')
    + '&sn_srid=4326&rpp=' + rpp
    + '&return_buildings=true';
  const r = await getJSON(url, null, 7500);
  const j = r.json;
  if (!r.ok || !j || j.status === 'error') {
    return { status: 'error', features: [], note: 'ReportAll ' + ((j && j.message) || ('HTTP ' + r.status)) };
  }
  const results = j.results || [];
  if (!results.length) return { status: 'no_coverage', features: [], note: 'No ReportAll parcels at this point' };
  const parcels = results.map(normalizeReportAllRecord);
  return { status: 'covered', features: results, parcels: parcels, note: 'ReportAll USA (nationwide parcel data)' };
}

async function regridParcels(o) {
  const KEY = env('regrid', 'REGRID', 'REGRID_API_KEY', 'REGRID_TOKEN');
  if (!KEY) return { status: 'no_key', features: [], note: 'Regrid token not set' };
  const url = 'https://app.regrid.com/api/v2/parcels/point'
    + '?lat=' + o.lat + '&lon=' + o.lon
    + '&radius=' + o.radius + '&limit=' + o.limit
    + '&token=' + encodeURIComponent(KEY);
  const r = await getJSON(url, null, 7000);
  const j = r.json;
  const feats = (j && (j.parcels && j.parcels.features ? j.parcels.features : (j.features || []))) || [];
  if (!r.ok) return { status: 'error', features: [], note: 'Regrid HTTP ' + r.status };
  if (!feats.length) return { status: 'no_coverage', features: [], note: 'County not in current Regrid plan' };
  return { status: 'covered', features: feats, note: 'Regrid' };
}

// IndianaMap: the State of Indiana's public statewide parcel layer, compiled
// yearly from every county by the Indiana Geographic Information Office.
// Verified live 2026-07-04 against Parcel_Boundaries_of_Indiana_Current
// (Delaware County polygons returned for Muncie). No key, no contract, public
// record. It publishes geometry + parcel IDs + source county; it does NOT
// publish owner or assessed value, and Cividian says so instead of papering
// over it. This is the coverage fallback that keeps Indiana first-class while
// the Regrid plan licenses only some counties.
const INMAP_URL = 'https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0/query';
async function indianaMapParcels(o) {
  // Indiana bounding box guard: skip the call entirely outside the state.
  if (!(o.lat >= 37.7 && o.lat <= 41.8 && o.lon >= -88.2 && o.lon <= -84.6)) {
    return { status: 'no_coverage', features: [], parcels: [], note: 'IndianaMap covers Indiana only' };
  }
  const url = INMAP_URL
    + '?geometry=' + o.lon + ',' + o.lat
    + '&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects'
    + '&distance=' + o.radius + '&units=esriSRUnit_Meter'
    + '&outFields=local_id,source_originator,county_fips,dlgf_prop_address,dlgf_prop_address_city,dlgf_prop_class_code,esri_poname,esri_zip'
    + '&f=geojson&resultRecordCount=' + o.limit;
  const r = await getJSON(url, null, 9000);
  const feats = (r.json && r.json.features) || [];
  if (!r.ok) return { status: 'error', features: [], parcels: [], note: 'IndianaMap HTTP ' + r.status };
  if (!feats.length) return { status: 'no_coverage', features: [], parcels: [], note: 'No parcels returned at this point' };
  const parcels = feats.map(function (f) {
    const p = f.properties || {};
    const addr = p.dlgf_prop_address
      ? (p.dlgf_prop_address + (p.dlgf_prop_address_city ? (', ' + p.dlgf_prop_address_city) : ''))
      : ('Parcel ' + (p.local_id || 'on record') + (p.esri_poname ? (' · ' + p.esri_poname) : ''));
    return {
      geometry: f.geometry,
      addr: addr,
      // The state layer does not publish ownership or assessed value. null here
      // means "not in this public feed", and the UI renders that honestly.
      owner: null,
      // The state layer publishes no sale records either.
      salePrice: null,
      saleDate: null,
      use: p.dlgf_prop_class_code ? ('Class ' + p.dlgf_prop_class_code) : 'Use not published by county feed',
      zoning: '',
      acre: null,
      value: null,
      bldgSqft: null,
      bldgFootprintSqft: null,
      yearBuilt: null,
      source: (p.source_originator || 'County') + ' via IndianaMap'
    };
  });
  return { status: 'covered', features: feats, parcels: parcels, note: 'IndianaMap (State of Indiana public parcel layer)' };
}

// Placeholder for a second commercial source to fill coverage gaps.
// Wire when a key is added; keeps the all-cities promise vendor-independent.
async function zoneomicsParcels(/* o */) {
  const KEY = env('zoneomics', 'ZONEOMICS', 'ZONEOMICS_API_KEY');
  if (!KEY) return { status: 'no_key', features: [], note: 'Zoneomics not configured' };
  return { status: 'no_key', features: [], note: 'Zoneomics parcel adapter not yet implemented' };
}

const PARCEL_PROVIDERS = [
  { name: 'reportall', fn: reportallParcels },
  { name: 'regrid', fn: regridParcels },
  { name: 'indianamap', fn: indianaMapParcels },
  { name: 'zoneomics', fn: zoneomicsParcels }
];

// ---------------------------------------------------------------------------
// THE TWO REGISTRIES.
//
// US and UK sources are kept in separate registries that share a contract and
// nothing else. The point is structural: fetchParcels below walks US_PROVIDERS
// and cannot reach a UK adapter, so a UK vendor that hangs, 500s or changes its
// schema has no path by which it could degrade a US lookup. The UK adapters
// live in lib/providers-uk.js because they are long; both registries are named
// HERE so the separation is visible in one place rather than implied by two
// files nobody reads together.
//
// Adding a UK source to US_PROVIDERS, or the reverse, is the one edit this
// design exists to prevent.
// ---------------------------------------------------------------------------
export const US_PROVIDERS = PARCEL_PROVIDERS;
export { UK_DESIGNATION_PROVIDERS as UK_PROVIDERS, ukIntegrationStatus, ATTRIBUTION as UK_ATTRIBUTION } from './providers-uk.js';

export async function fetchParcels(o) {
  const opts = {
    lat: o.lat, lon: o.lon,
    radius: Math.min(parseInt(o.radius) || 350, 1500),
    limit: Math.min(parseInt(o.limit) || 90, 300)
  };
  // Cache key is the rounded query grid (~11m) plus radius/limit, so an
  // identical view resolves from Redis and never re-hits a paid vendor. The
  // FULL parcel record (owner/value included) is cached; the API layer strips
  // sensitive fields per session, so caching raw does not leak gated data.
  const gk = 'pago:parcels:' + (Math.round(opts.lat * 1e4) / 1e4) + ':' + (Math.round(opts.lon * 1e4) / 1e4) + ':' + opts.radius + ':' + opts.limit;
  try {
    const hit = await getKey(gk);
    if (hit && hit.coverage) return Object.assign({}, hit, { cached: true });
  } catch (e) {}

  const tried = [];
  for (let i = 0; i < PARCEL_PROVIDERS.length; i++) {
    const prov = PARCEL_PROVIDERS[i];
    const r = await prov.fn(opts);
    tried.push({ provider: prov.name, status: r.status, note: r.note, count: r.features.length });
    if (r.status === 'covered') {
      const covered = {
        ok: true, provider: prov.name, coverage: 'covered',
        count: r.features.length,
        // Adapters may pre-normalize (public feeds with their own schema);
        // otherwise the Regrid-shaped normalizer applies.
        parcels: r.parcels && r.parcels.length ? r.parcels : r.features.map(normalizeParcel),
        tried: tried
      };
      try { await setKeyEx(gk, covered, PARCEL_TTL); } catch (e) {}
      return covered;
    }
  }
  // Nobody had data. Distinguish "no provider configured" from "configured but
  // this county is not licensed" so the UI can show the right message.
  const anyKey = tried.some(function (t) { return t.status !== 'no_key'; });
  const miss = {
    ok: false,
    provider: null,
    coverage: anyKey ? 'no_coverage' : 'no_key',
    count: 0,
    parcels: [],
    tried: tried
  };
  // Cache a real no_coverage briefly so an unlicensed county is not re-queried
  // on every map interaction; never cache no_key (config may change).
  if (miss.coverage === 'no_coverage') { try { await setKeyEx(gk, miss, PARCEL_MISS_TTL); } catch (e) {} }
  return miss;
}

// ---------------------------------------------------------------------------
// ZONING PROVIDERS
// A zoning envelope is what turns "show me the lot" into "show me what is
// LEGAL to build on the lot." That envelope is the input to the 3D massing.
// Envelope shape (Cividian schema):
//   { district, far, maxHeightFt, frontSetbackFt, sideSetbackFt,
//     rearSetbackFt, maxStories, allowedUses:[], source, confidence }
// ---------------------------------------------------------------------------

async function gridicsZoning(/* o */) {
  const KEY = env('gridics', 'GRIDICS', 'GRIDICS_API_KEY', 'GRIDICS_TOKEN');
  if (!KEY) return { status: 'no_key', envelope: null, note: 'Gridics key not set (API call scheduled)' };
  // NOTE: exact request shape is finalized against developer.gridics.com once
  // the key and redistribution terms are confirmed. Deliberately not guessed
  // here so Cividian never ships a silently-wrong zoning answer.
  return { status: 'pending_integration', envelope: null, note: 'Gridics adapter awaiting verified endpoint + redistribution rights' };
}

async function zoneomicsZoning(/* o */) {
  const KEY = env('zoneomics', 'ZONEOMICS', 'ZONEOMICS_API_KEY');
  if (!KEY) return { status: 'no_key', envelope: null, note: 'Zoneomics key not set' };
  return { status: 'pending_integration', envelope: null, note: 'Zoneomics zoning adapter not yet implemented' };
}

const ZONING_PROVIDERS = [
  { name: 'gridics', fn: gridicsZoning },
  { name: 'zoneomics', fn: zoneomicsZoning }
];

export async function fetchZoning(o) {
  const tried = [];
  for (let i = 0; i < ZONING_PROVIDERS.length; i++) {
    const prov = ZONING_PROVIDERS[i];
    const r = await prov.fn(o);
    tried.push({ provider: prov.name, status: r.status, note: r.note });
    if (r.status === 'covered' && r.envelope) {
      return { ok: true, provider: prov.name, envelope: r.envelope, source: 'live', tried: tried };
    }
  }
  return { ok: false, provider: null, envelope: null, source: 'none', tried: tried };
}
