// lib/providers-uk.js
// UK data source adapters. Every one resolves to the house contract:
//   { status: 'covered'|'no_coverage'|'no_key'|'error', features: [], note }
//
// These are registered as UK_PROVIDERS in lib/providers.js and are never mixed
// into the US chain. A UK vendor failure cannot reach a US lookup because the
// two registries share no code path, only a contract.
//
// The single most dangerous thing this file can do is report an empty result as
// an absence of constraint. planning.data.gov.uk is a national interface over
// data each local planning authority publishes for itself, and many have
// published nothing. Verified live 2026-08-10: Kingston upon Hull has published
// 26 conservation areas and ZERO listed buildings, while the National Heritage
// List for England returns 44 listed buildings within 120 m of the
// Whitefriargate midpoint, one of them Grade I. An adapter that reported that
// as "no listed buildings" would tell a user it is safe to gut a Grade I
// building. Every empty result from an LPA-published dataset therefore goes
// through coveredOrNoCoverage() below, which asks whether that authority has
// published anything at all before it says anything about this point.

import { getKey, setKeyEx } from './redis.js';
import { organisationFor, bngToWgs84 } from './geo-uk.js';

const TIMEOUT_MS = 7500;
const DAY = 24 * 3600;
// Designations change on the timescale of a council committee, not a day.
const DESIGNATION_TTL = 7 * DAY;
// Whether an authority has published a dataset at all changes even more slowly,
// and this is the query that runs on every empty result, so it is worth holding.
const COVERAGE_TTL = 30 * DAY;
const NHLE_TTL = 30 * DAY;
// A miss here always means "the source did not answer", never "the source
// answered nothing": a genuine empty result is returned as an empty array and
// cached as a hit. So this is a RETRY interval, not a negative cache, and it is
// ten minutes rather than the six hours used elsewhere in the codebase.
//
// The reason is measured. The identical planning.data.gov.uk query timed five
// times on 2026-08-10 returned in 0.54s, 0.70s, 0.36s, 11.34s and 10.60s. With
// a six hour miss TTL, one slow response pins an honest "did not answer" over a
// designation layer that exists, for the rest of the working day, and the user
// sees a platform fault where there was a slow afternoon.
const MISS_TTL = 600;

const UA = 'Cividian/1.0 (contact: ' + (process.env.CONTACT_EMAIL || 'contact@cividian.com') + ')';

// ---------------------------------------------------------------------------
// Attribution. These strings are obligations, not decoration, and they are
// exported so the map component and the API envelope render the same text. The
// build brief is explicit that this belongs in the component rather than in a
// footer somebody will forget.
// ---------------------------------------------------------------------------
export const ATTRIBUTION = {
  os: 'Contains OS data, Crown copyright and database right 2026.',
  // Mandatory wherever INSPIRE geometry is reused, licence number included.
  inspire: 'Contains HM Land Registry data, Crown copyright and database right 2026. '
    + 'This data is licensed under the Open Government Licence v3.0. '
    + 'Contains Ordnance Survey data, Crown copyright and database right 2026, licence number AC0000851063.',
  // Fixed string, quoted verbatim from the build brief. An INSPIRE polygon is
  // an indicative extent and presenting it as a legal boundary is the fastest
  // route from a data product to a negligence claim.
  inspireCaveat: 'Indicative extent only. Legal boundaries can only be established from the title plan.',
  ogl: 'Open Government Licence v3.0.',
  nhle: 'Crown Copyright 2026. Contains Ordnance Survey data, Crown copyright and database right 2026. Released under OGL.',
  planning: 'MHCLG Planning Data Platform. Open Government Licence v3.0.',
};

function env(/* names */) {
  for (let i = 0; i < arguments.length; i++) {
    const v = process.env[arguments[i]];
    if (v) return v;
  }
  return null;
}

async function getJSON(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal, headers: { 'user-agent': UA } }, opts || {}));
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ok: r.ok, json: j, snippet: txt.slice(0, 160) };
  } catch (e) {
    return { status: 0, ok: false, json: null, snippet: 'err: ' + String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

async function memo(key, ttl, producer) {
  try {
    const hit = await getKey(key);
    if (hit && hit.v !== undefined) return hit.v;
    if (hit && hit.miss) return null;
  } catch (e) {}
  let v = null;
  try { v = await producer(); } catch (e) { v = null; }
  try { await setKeyEx(key, v == null ? { miss: true } : { v: v }, v == null ? MISS_TTL : ttl); } catch (e) {}
  return v;
}

// ---------------------------------------------------------------------------
// Who publishes what.
//
// This table is the difference between an honest empty and a dangerous one. A
// dataset published nationally by a single body (the Environment Agency, HM
// Land Registry, Historic England) is complete by construction, so an empty
// point result is a real "nothing here". A dataset published authority by
// authority is only as complete as that authority chose to make it, so an empty
// point result means nothing at all until the authority's own publication
// record is checked.
//
// Publisher entity ids verified live 2026-08-10 against
// https://www.planning.data.gov.uk/entity.json
// ---------------------------------------------------------------------------
export const PLANNING_DATASETS = {
  'conservation-area': { publisher: 'lpa', label: 'Conservation area' },
  'listed-building': { publisher: 'lpa', label: 'Listed building', authoritative: 'nhle' },
  'listed-building-outline': { publisher: 'lpa', label: 'Listed building outline', authoritative: 'nhle' },
  'article-4-direction-area': { publisher: 'lpa', label: 'Article 4 direction area' },
  'tree-preservation-zone': { publisher: 'lpa', label: 'Tree preservation zone' },
  'brownfield-land': { publisher: 'lpa', label: 'Brownfield land' },
  'locally-listed-building': { publisher: 'lpa', label: 'Locally listed building' },
  'design-code-area': { publisher: 'lpa', label: 'Design code area' },
  'flood-risk-zone': { publisher: 'national', org: 600009, body: 'Environment Agency', label: 'Flood risk zone' },
  'heritage-at-risk': { publisher: 'national', org: 16, body: 'Historic England', label: 'Heritage at risk' },
  'scheduled-monument': { publisher: 'national', org: 16, body: 'Historic England', label: 'Scheduled monument' },
  'park-and-garden': { publisher: 'national', org: 16, body: 'Historic England', label: 'Historic park or garden' },
  'battlefield': { publisher: 'national', org: 16, body: 'Historic England', label: 'Battlefield' },
  'world-heritage-site': { publisher: 'national', org: 16, body: 'Historic England', label: 'World heritage site' },
  'protected-wreck-site': { publisher: 'national', org: 16, body: 'Historic England', label: 'Protected wreck site' },
  'building-preservation-notice': { publisher: 'national', org: 16, body: 'Historic England', label: 'Building preservation notice' },
  'certificate-of-immunity': { publisher: 'national', org: 16, body: 'Historic England', label: 'Certificate of immunity' },
  'heritage-action-zone': { publisher: 'national', org: 16, body: 'Historic England', label: 'Heritage action zone' },
  'title-boundary': { publisher: 'national', org: 13, body: 'HM Land Registry', label: 'Title boundary', inspire: true },
};

export function isKnownDataset(d) {
  return Object.prototype.hasOwnProperty.call(PLANNING_DATASETS, String(d));
}

// Has this organisation published anything at all in this dataset? One cached
// query, held 30 days. The answer is what turns an empty point result into
// either "no constraint here" or "this authority has published nothing, so
// nothing is known here".
async function organisationHasPublished(dataset, orgEntity) {
  if (!orgEntity) return null;
  return memo('pago:uk:planning:published:' + dataset + ':' + orgEntity, COVERAGE_TTL, async function () {
    const r = await getJSON('https://www.planning.data.gov.uk/entity.json?dataset=' + encodeURIComponent(dataset)
      + '&organisation_entity=' + encodeURIComponent(orgEntity) + '&limit=1');
    if (!r.ok || !r.json || typeof r.json.count !== 'number') return null;
    return { count: r.json.count };
  });
}

// WKT POINT and the geometry field planning.data.gov.uk returns. Only POINT is
// parsed here; polygon geometry is requested only where it is actually drawn,
// and the entity endpoint returns it as WKT which lib/providers.js already has
// a parser for.
export function parseWktPoint(wkt) {
  const m = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(String(wkt || '').trim());
  if (!m) return null;
  const lon = Number(m[1]), lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lat: lat, lon: lon } : null;
}

// One planning.data.gov.uk entity into the Cividian designation shape. Pure.
export function normalizeDesignation(e, dataset) {
  if (!e || typeof e !== 'object') return null;
  const meta = PLANNING_DATASETS[dataset] || {};
  const pt = parseWktPoint(e.point);
  return {
    dataset: dataset,
    label: meta.label || dataset,
    entity: e.entity != null ? String(e.entity) : null,
    // Reference is the publisher's own identifier. For heritage-at-risk it is
    // the NHLE list entry number, which is the join key back to the National
    // Heritage List, so it is never dropped.
    reference: e.reference || null,
    name: e.name || null,
    startDate: e['start-date'] || null,
    entryDate: e['entry-date'] || null,
    endDate: e['end-date'] || null,
    organisationEntity: e['organisation-entity'] != null ? String(e['organisation-entity']) : null,
    // "authoritative" on a planning.data.gov.uk entity means the publisher is
    // the body of record for it, which for title-boundary and heritage-at-risk
    // it is, and for an LPA copy of a listed building it is not.
    quality: e.quality || null,
    documentationUrl: e['documentation-url'] || null,
    point: pt,
    geometry: e.geometry || null,
  };
}

// ---------------------------------------------------------------------------
// 1. MHCLG Planning Data Platform
// ---------------------------------------------------------------------------

export async function planningDesignations(o) {
  const lat = Number(o && o.lat), lon = Number(o && o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 'error', features: [], byDataset: {}, note: 'A latitude and longitude are required.' };
  }
  const requested = (Array.isArray(o.datasets) && o.datasets.length ? o.datasets : Object.keys(PLANNING_DATASETS))
    .map(String).filter(isKnownDataset).slice(0, 20);
  if (!requested.length) {
    return { status: 'error', features: [], byDataset: {}, note: 'No recognised dataset was requested.' };
  }

  const rl = Math.round(lat * 1e4) / 1e4;
  const rn = Math.round(lon * 1e4) / 1e4;
  const key = 'pago:uk:planning:' + requested.slice().sort().join('+') + ':' + rl + ',' + rn;

  const raw = await memo(key, DESIGNATION_TTL, async function () {
    const qs = requested.map(function (d) { return 'dataset=' + encodeURIComponent(d); }).join('&');
    // The house per-vendor budget is 8000 ms and this source needs more than
    // that. Measured 2026-08-10, the SAME five dataset query at the same point
    // returned in 0.54s, 0.70s, 0.36s, 11.34s and 10.60s, and the
    // title-boundary point query, over 4.25 million polygons, took 7.2s. An
    // 8000 ms budget therefore fails on roughly two requests in five and the
    // layer reports "did not answer" over data that is there.
    //
    // 14000 ms is still comfortably inside the 30s function ceiling and inside
    // the caller's own withTimeout budget, and the result is cached for seven
    // days, so the slow path is paid once per point rather than per pageview.
    const budget = Number(o.timeoutMs) || 14000;
    const r = await getJSON('https://www.planning.data.gov.uk/entity.json?latitude=' + rl + '&longitude=' + rn
      + '&' + qs + '&limit=100', null, budget);
    if (!r.ok || !r.json || !Array.isArray(r.json.entities)) return null;
    return { entities: r.json.entities, count: r.json.count };
  });

  if (!raw) {
    return {
      status: 'error', features: [], byDataset: {},
      note: 'The MHCLG Planning Data Platform did not answer for this point. No designation claim is made either way.',
    };
  }

  const org = await organisationFor(o.lpaCode, o.ladCode);
  const orgEntity = (o.organisationEntity != null) ? o.organisationEntity : (org ? org.entity : null);
  const lpaName = o.lpaName || (org ? org.name : null) || 'this local planning authority';

  const byDataset = {};
  const features = [];
  for (let i = 0; i < requested.length; i++) {
    const d = requested[i];
    const hits = raw.entities.filter(function (e) { return e.dataset === d; }).map(function (e) { return normalizeDesignation(e, d); });
    hits.forEach(function (h) { features.push(h); });
    byDataset[d] = await coverageFor(d, hits, orgEntity, lpaName);
  }

  const unknown = Object.keys(byDataset).filter(function (d) { return byDataset[d].status === 'no_coverage'; });
  return {
    status: unknown.length === requested.length ? 'no_coverage' : 'covered',
    features: features,
    byDataset: byDataset,
    // The caveat rides on every response, not only on the empty ones, because a
    // user reading three designations still needs to know the fourth was never
    // published.
    coverageCaveat: 'planning.data.gov.uk publishes what each local planning authority has chosen to publish. '
      + 'An absent dataset means nothing is known, not that no constraint exists. '
      + (unknown.length
        ? (lpaName + ' has published nothing to ' + unknown.length + ' of the ' + requested.length + ' datasets queried here: ' + unknown.join(', ') + '.')
        : ('All ' + requested.length + ' datasets queried here are published for this area.')),
    attribution: ATTRIBUTION.planning,
    note: features.length
      ? (features.length + ' designation records at this point across ' + (requested.length - unknown.length) + ' published datasets.')
      : 'No designation records at this point. See coverageCaveat for which datasets were actually readable.',
  };
}

// The honest discrimination, isolated so it can be unit tested without network.
async function coverageFor(dataset, hits, orgEntity, lpaName) {
  const meta = PLANNING_DATASETS[dataset] || {};
  if (hits.length) {
    return { status: 'covered', count: hits.length, features: hits, note: hits.length + ' record(s) at this point.' };
  }
  if (meta.publisher === 'national') {
    // A single national publisher means the dataset is complete by
    // construction, so an empty result at a point is a real absence.
    return {
      status: 'covered', count: 0, features: [],
      note: 'No ' + (meta.label || dataset).toLowerCase() + ' at this point. '
        + (meta.body || 'A single national body') + ' publishes this dataset for the whole of England, so this is a real absence rather than a gap in publication.',
    };
  }
  const published = await organisationHasPublished(dataset, orgEntity);
  if (published && published.count > 0) {
    return {
      status: 'covered', count: 0, features: [],
      note: 'No ' + (meta.label || dataset).toLowerCase() + ' at this point. ' + lpaName + ' has published '
        + published.count + ' record(s) in this dataset, so this point being empty is a real absence.',
    };
  }
  // Either the authority has published nothing, or the publication check itself
  // failed. Both are no_coverage: in neither case does the platform know
  // whether a constraint exists.
  return {
    status: 'no_coverage', count: 0, features: [],
    note: published
      ? (lpaName + ' has published no ' + (meta.label || dataset).toLowerCase() + ' data to planning.data.gov.uk at all. '
        + 'This point being empty says nothing about whether a ' + (meta.label || dataset).toLowerCase() + ' exists here.'
        + (meta.authoritative === 'nhle' ? ' The National Heritage List for England is the authoritative source and is queried separately.' : ''))
      : ('Whether ' + lpaName + ' publishes ' + (meta.label || dataset).toLowerCase() + ' data could not be established, so no claim is made about this point.'),
  };
}

// ---------------------------------------------------------------------------
// 2. Historic England, National Heritage List for England
//
// The authoritative national register. Layer ids verified live 2026-08-10
// against the service's own metadata; the service is keyless and the copyright
// string below is quoted from its copyrightText field.
// ---------------------------------------------------------------------------
const NHLE = 'https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer';
export const NHLE_LAYERS = {
  listedBuildingPoints: 0,
  buildingPreservationNoticePoints: 1,
  certificateOfImmunityPoints: 2,
  listedBuildingPolygons: 3,
  scheduledMonuments: 6,
  parksAndGardens: 7,
  battlefields: 8,
  protectedWreckSites: 9,
  worldHeritageSites: 10,
};

// Pure. Maps one NHLE feature into the Cividian listing shape. Grade is the
// literal register value, never normalised into a number: "II*" is not "2.5"
// and a consumer that sorts it numerically should be forced to think.
export function normalizeNhle(f) {
  const a = (f && f.attributes) || {};
  const listEntry = a.ListEntry != null ? String(a.ListEntry) : null;
  const iso = function (ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return null;
    try { return new Date(Number(ms)).toISOString().slice(0, 10); } catch (e) { return null; }
  };
  return {
    listEntry: listEntry,
    name: a.Name || null,
    grade: a.Grade || null,
    listDate: iso(a.ListDate),
    amendDate: iso(a.AmendDate),
    // CaptureScale matters: a record captured at 1:2500 cannot be used to say
    // which of two adjacent shopfronts is the listed one.
    captureScale: a.CaptureScale || null,
    url: a.hyperlink || (listEntry ? 'https://historicengland.org.uk/listing/the-list/list-entry/' + listEntry : null),
    ngr: a.NGR || null,
    easting: a.Easting != null ? Number(a.Easting) : null,
    northing: a.Northing != null ? Number(a.Northing) : null,
    // Converted here from British National Grid rather than requested from the
    // service in WGS84. See the outSR quirk documented on the query below and
    // in bngToWgs84: asking the service to reproject loses records.
    point: bngToWgs84(a.Easting, a.Northing),
    source: 'nhle',
    provenance: 'Historic England, National Heritage List for England, read live. ' + ATTRIBUTION.nhle,
  };
}

// A LIST ENTRY IS NOT A BUILDING, and conflating the two is how a heritage
// count silently disagrees with every published figure.
//
// Verified at Whitefriargate 2026-08-10: the National Heritage List holds 12
// entries naming the street, 11 Grade II and 1 Grade II*. Those 12 entries
// cover roughly 42 street numbers, because one entry routinely spans a terrace
// ("24-28 Whitefriargate", "21, 22 and 23 Whitefriargate"). A published figure
// of "30 Grade II listed buildings on Whitefriargate" is counting numbers; a
// query against the register is counting entries. Neither is wrong and they
// will never match, so both are reported with the basis named.
//
// This parses the numeric prefix of a list entry name. It is a heuristic over
// free text and says so in its provenance: a name with no leading numbers
// counts as one, which understates a terrace described in words alone.
export function addressedBuildingCount(name) {
  const s = String(name || '');
  // Only the leading address run, before the first descriptive clause. Taking
  // digits from the whole string would count "Numbers 6-10 Alfred Gelder
  // Street" a second time for a building already counted on its own street.
  const head = (s.split(/,\s*(?=[A-Za-z]{4,})|\(/)[0] || s).slice(0, 120);
  const runs = head.match(/\d+\s*-\s*\d+|\d+/g);
  if (!runs || !runs.length) return { count: 1, exact: false };
  let total = 0;
  runs.forEach(function (r) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(r.replace(/\s+/g, ''));
    if (range) {
      const lo = Number(range[1]), hi = Number(range[2]);
      // A range that runs backwards or spans a whole street is a date or a
      // misparse, not an address run.
      total += (hi >= lo && hi - lo < 60) ? (hi - lo + 1) : 1;
    } else {
      total += 1;
    }
  });
  return { count: Math.max(1, total), exact: true };
}

export function gradeTally(rows) {
  const t = {
    grade_i: 0, grade_ii_star: 0, grade_ii: 0, ungraded: 0,
    // Both counts, always, so nothing downstream has to guess which one it has.
    listEntries: 0, addressedBuildings: 0,
    countBasis: 'grade counts are LIST ENTRIES. addressedBuildings estimates the street numbers those entries cover, '
      + 'because one entry routinely spans a terrace. A figure published for a named street usually counts numbers, so it will read higher than the entry count. '
      + 'The building estimate is parsed from entry names and is a heuristic, not a register field.',
  };
  (rows || []).forEach(function (r) {
    if (r.grade === 'I') t.grade_i++;
    else if (r.grade === 'II*') t.grade_ii_star++;
    else if (r.grade === 'II') t.grade_ii++;
    else t.ungraded++;
    t.listEntries++;
    t.addressedBuildings += addressedBuildingCount(r.name).count;
  });
  return t;
}

export async function nhleListedBuildings(o) {
  const lat = Number(o && o.lat), lon = Number(o && o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 'error', features: [], note: 'A latitude and longitude are required.' };
  }
  // The default radius is deliberately small. A town centre block is tens of
  // metres across, and a generous radius sweeps in the next three streets and
  // inflates the count against any published figure.
  const radius = Math.max(10, Math.min(parseInt(o.radius, 10) || 120, 1000));
  const rl = Math.round(lat * 1e4) / 1e4;
  const rn = Math.round(lon * 1e4) / 1e4;

  // Fetch a padded superset, then filter exactly. Three separate things
  // disagree about where the edge of a radius is, and all three were measured
  // at Whitefriargate on 2026-08-10:
  //
  //   1. Rounding the query point to four decimal places for the cache key
  //      moves it up to about 8 m, which on its own dropped list entries
  //      1219563 (HULL TRINITY HOUSE, Grade I) and 1297023 from a 120 m query.
  //   2. The layer is native EPSG:27700 and the caller's point is WGS84, so
  //      the service's own distance measure carries a datum transformation
  //      this code does not control.
  //   3. outSR reprojection loses features outright, documented on the query.
  //
  // Padding the fetch and doing the distance arithmetic here removes all three
  // from the answer. The service decides roughly what to send; Cividian decides
  // exactly what is inside the radius the caller asked for, measured from the
  // caller's real point, in one consistent space. The padded superset is what
  // gets cached, so a re-query at a slightly different point still filters
  // correctly out of the same cache entry.
  const FETCH_PAD_M = 200;
  const fetchRadius = radius + FETCH_PAD_M;

  const rows = await memo('pago:uk:nhle:listed:' + rl + ',' + rn + ':' + fetchRadius, NHLE_TTL, async function () {
    // DO NOT ADD outSR TO THIS QUERY. The layer is native EPSG:27700 and the
    // service loses features when it reprojects: measured 2026-08-10 at this
    // exact point and radius, 44 features come back natively and 42 come back
    // with outSR=4326, and the two it drops are list entries 1219563 (HULL
    // TRINITY HOUSE, Grade I) and 1297023 (6 Posterngate, Grade II). Both have
    // ordinary single-point geometry, so this is the service losing them in
    // transformation. Coordinates are converted from the Easting and Northing
    // attributes instead, which every record carries.
    //
    // returnGeometry is false for the same reason: the attributes are the
    // reliable carrier, and a Multipoint geometry adds nothing here.
    const url = NHLE + '/' + NHLE_LAYERS.listedBuildingPoints + '/query'
      + '?geometry=' + encodeURIComponent(rn + ',' + rl)
      + '&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects'
      + '&distance=' + fetchRadius + '&units=esriSRUnit_Meter'
      + '&outFields=' + encodeURIComponent('ListEntry,Name,Grade,ListDate,AmendDate,CaptureScale,hyperlink,NGR,Easting,Northing')
      + '&returnGeometry=false&resultRecordCount=2000&f=json';
    const r = await getJSON(url, null, 8000);
    // An ArcGIS service answers 200 with an error object in the body, so an ok
    // status is not enough to call this a read.
    if (!r.ok || !r.json || r.json.error || !Array.isArray(r.json.features)) return null;
    return r.json.features.map(normalizeNhle);
  });

  if (!rows) {
    return {
      status: 'error', features: [],
      note: 'The National Heritage List for England did not answer. No listing claim is made either way, which matters more here than anywhere else in the product.',
    };
  }

  // Exact distance from the caller's real point, in metres, computed here.
  // A record whose coordinates will not convert keeps a null distance and is
  // kept rather than dropped: a listed building with an unreadable grid
  // reference is still a listed building, and silently discarding it is the
  // failure mode this whole adapter exists to avoid.
  const withDistance = rows.map(function (r) {
    const d = (r.point && r.point.lat != null) ? Math.round(haversineM(lat, lon, r.point.lat, r.point.lon)) : null;
    return Object.assign({}, r, { distanceM: d });
  });
  const inside = withDistance.filter(function (r) { return r.distanceM == null || r.distanceM <= radius; });
  inside.sort(function (a, b) { return (a.distanceM == null ? 1e9 : a.distanceM) - (b.distanceM == null ? 1e9 : b.distanceM); });
  const unplaced = inside.filter(function (r) { return r.distanceM == null; }).length;

  if (!inside.length) {
    // NHLE is the national register, so an empty answer here IS a real absence,
    // unlike an empty answer from an LPA feed.
    return {
      status: 'covered', features: [], tally: gradeTally([]), radius: radius,
      attribution: ATTRIBUTION.nhle,
      note: 'No listed buildings within ' + radius + ' m. The National Heritage List for England is the national register, so this is a real absence. '
        + withDistance.length + ' record(s) were read in the surrounding ' + fetchRadius + ' m and all fell outside the requested radius.',
    };
  }
  return {
    status: 'covered',
    features: inside,
    tally: gradeTally(inside),
    radius: radius,
    fetchRadius: fetchRadius,
    nearby: withDistance.length - inside.length,
    attribution: ATTRIBUTION.nhle,
    note: inside.length + ' listed buildings within ' + radius + ' m of the query point, read from the National Heritage List for England, '
      + 'with distance measured by Cividian from the grid reference on each record rather than by the map service. '
      + (withDistance.length - inside.length) + ' further record(s) sit between ' + radius + ' m and ' + fetchRadius + ' m. '
      + (unplaced ? (unplaced + ' record(s) carry a grid reference that would not convert and are included rather than dropped. ') : '')
      + 'A radius catches adjoining streets, so this count is a superset of any figure published for one named street.',
  };
}

// Metres, from the shared great circle. Distances at block scale are small
// enough that the ellipsoid difference is far inside the capture scale of the
// source records.
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// 3. Heritage at Risk
//
// Served live through planning.data.gov.uk rather than the annual spreadsheet:
// dataset heritage-at-risk, publisher Historic England (organisation entity
// 16), 5,490 entities nationally, quality "authoritative", verified live
// 2026-08-10. reference is the NHLE list entry number, which is the join key.
// ---------------------------------------------------------------------------
export async function heritageAtRisk(o) {
  const lat = Number(o && o.lat), lon = Number(o && o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 'error', features: [], note: 'A latitude and longitude are required.' };
  }
  const res = await planningDesignations({ lat: lat, lon: lon, datasets: ['heritage-at-risk'], organisationEntity: 16, lpaName: 'Historic England' });
  const band = res.byDataset && res.byDataset['heritage-at-risk'];
  if (!band) return { status: 'error', features: [], note: res.note };
  return {
    status: band.status,
    features: band.features || [],
    listEntries: (band.features || []).map(function (f) { return f.reference; }).filter(Boolean),
    attribution: ATTRIBUTION.planning,
    note: band.note + ' Heritage at Risk is published nationally by Historic England and joins to the National Heritage List by list entry number.',
  };
}

// ---------------------------------------------------------------------------
// Merge, without collapsing two provenances into one number.
//
// The build brief forbids merging NHLE and planning.data.gov.uk listed building
// records into one count. It does not forbid relating them, and relating them
// is the whole point: where they disagree, the disagreement is the finding.
// ---------------------------------------------------------------------------
export function reconcileListings(nhle, planningBand, atRisk) {
  const nhleRows = (nhle && nhle.features) || [];
  const lpaRows = (planningBand && planningBand.features) || [];
  const riskSet = {};
  ((atRisk && atRisk.listEntries) || []).forEach(function (r) { riskSet[String(r)] = true; });

  const rows = nhleRows.map(function (r) {
    return Object.assign({}, r, { atRisk: r.listEntry ? !!riskSet[r.listEntry] : null });
  });
  const lpaPublished = planningBand ? planningBand.status === 'covered' : false;
  return {
    listings: rows,
    tally: gradeTally(rows),
    atRiskCount: rows.filter(function (r) { return r.atRisk === true; }).length,
    sources: {
      nhle: {
        status: nhle ? nhle.status : 'error',
        count: nhleRows.length,
        role: 'authoritative national register',
        provenance: 'Historic England, National Heritage List for England. ' + ATTRIBUTION.nhle,
      },
      planning: {
        status: planningBand ? planningBand.status : 'no_coverage',
        count: lpaRows.length,
        role: 'the local planning authority copy, as published',
        provenance: ATTRIBUTION.planning,
      },
    },
    // The sentence a user actually needs when the two disagree.
    reconciliation: !lpaPublished
      ? 'The local planning authority has published no listed building data, so only the national register answers here. The two cannot be compared for this area.'
      : (nhleRows.length === lpaRows.length
        ? 'The national register and the local planning authority copy agree on the count at this point.'
        : 'The national register holds ' + nhleRows.length + ' record(s) here and the local planning authority copy holds ' + lpaRows.length
          + '. Both are shown. The National Heritage List is the register of record; the authority copy reflects what that authority has published.'),
  };
}

// ---------------------------------------------------------------------------
// Registry. Exported for lib/providers.js, which names both registries in one
// place so the separation is visible rather than implied.
// ---------------------------------------------------------------------------
export const UK_DESIGNATION_PROVIDERS = [
  { name: 'planning_data_gov_uk', fn: planningDesignations, key: null, region: 'england' },
  { name: 'historic_england_nhle', fn: nhleListedBuildings, key: null, region: 'england' },
  { name: 'heritage_at_risk', fn: heritageAtRisk, key: null, region: 'england' },
];

// Reachability booleans for /api/status. Booleans only, never values, and for
// the keyless sources this reports "no key needed" rather than implying an
// unconfigured integration.
export function ukIntegrationStatus() {
  return {
    planning_data_gov_uk: true,
    historic_england_nhle: true,
    heritage_at_risk: true,
    postcodes_io: true,
    os_open_uprn_ingested: null,
    hmlr: !!env('hmlr', 'HMLR', 'HMLR_API_KEY', 'LAND_REGISTRY_KEY'),
    epc: !!env('epc', 'EPC', 'EPC_API_KEY', 'EPC_TOKEN'),
    companies_house: !!env('companies_house', 'COMPANIES_HOUSE', 'CH_API_KEY'),
    voa: !!env('voa', 'VOA', 'VOA_LICENCE_ACCEPTED'),
  };
}

// ---------------------------------------------------------------------------
// 4. HM Land Registry Price Paid
//
// Open, Open Government Licence, England and Wales, no key. Served live through
// the HMLR Linked Data API at landregistry.data.gov.uk, verified 2026-08-10, so
// this needs neither the bulk CSV nor an account.
//
// One correction to carry forward: the bulk Price Paid file is documented as
// carrying UPRNs, and this API DOES NOT. A live record has paon, saon, street
// and postcode and nothing else, so the join to the UPRN spine is by address
// and is fuzzy. Every joined record says so in its provenance rather than
// implying a key match.
// ---------------------------------------------------------------------------
const PPD_TTL = 30 * DAY;

// The Linked Data API wraps every literal in an object, sometimes an array of
// them, and a naive read of estateType or propertyType yields "[object Object]"
// in a user-facing field. Pure, so the suite pins the unwrapping.
export function ldLabel(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const v = ldLabel(node[i]); if (v) return v; }
    return null;
  }
  if (typeof node === 'object') {
    if (node._value != null) return String(node._value);
    if (node.prefLabel != null) return ldLabel(node.prefLabel);
    if (node.label != null) return ldLabel(node.label);
  }
  return null;
}

// "Tue, 30 Sep 1997" is what the API actually returns. Date.parse handles it,
// but a value it cannot read becomes null rather than an Invalid Date that
// renders as "NaN" three layers up.
export function ldDate(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function normalizePricePaid(item) {
  if (!item || typeof item !== 'object') return null;
  const a = item.propertyAddress || {};
  const price = Number(item.pricePaid);
  const addr = [a.saon, a.paon, a.street].filter(Boolean).join(' ').trim() || null;
  return {
    transactionId: item.transactionId || null,
    price: Number.isFinite(price) ? price : null,
    date: ldDate(item.transactionDate),
    address: addr,
    saon: a.saon || null,
    paon: a.paon || null,
    street: a.street || null,
    postcode: a.postcode || null,
    town: a.town || null,
    district: a.district || null,
    propertyType: ldLabel(item.propertyType),
    // Freehold or leasehold. This is a tenure HINT for the block model, not the
    // tenure of the property today: it describes the interest that was sold in
    // that transaction, which may since have changed.
    estateType: ldLabel(item.estateType),
    newBuild: item.newBuild === true ? true : (item.newBuild === false ? false : null),
    category: ldLabel(item.transactionCategory),
    source: 'hmlr_price_paid',
    provenance: 'HM Land Registry Price Paid Data, read live from the HMLR Linked Data API. '
      + 'Open Government Licence v3.0. This feed carries no UPRN, so any join to a property record is by address and is not exact.',
  };
}

export async function hmlrPricePaid(o) {
  const pc = String((o && o.postcode) || '').trim().toUpperCase();
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/.test(pc)) {
    return { status: 'error', features: [], note: 'A normalized UK postcode is required.' };
  }
  const rows = await memo('pago:uk:ppd:' + pc, PPD_TTL, async function () {
    const url = 'https://landregistry.data.gov.uk/data/ppi/transaction-record.json'
      + '?propertyAddress.postcode=' + encodeURIComponent(pc)
      + '&_pageSize=100&_sort=-transactionDate';
    const r = await getJSON(url, null, 8000);
    const items = r.json && r.json.result && r.json.result.items;
    if (!r.ok || !Array.isArray(items)) return null;
    return items.map(normalizePricePaid).filter(Boolean);
  });
  if (!rows) {
    return { status: 'error', features: [], note: 'HM Land Registry Price Paid did not answer for ' + pc + '. No sale history claim is made.' };
  }
  if (!rows.length) {
    // Price Paid covers England and Wales completely for registered sales since
    // 1995, so an empty result is a real absence of RECORDED SALES. It is not
    // evidence that the property never changed hands: corporate transfers,
    // transfers of part, and sales below the threshold do not appear.
    return {
      status: 'covered', features: [],
      note: 'No recorded sales in ' + pc + '. Price Paid covers registered sales in England and Wales since 1995, so this is a real absence of recorded sales. '
        + 'It is not evidence that nothing changed hands: share transfers, transfers of part and sales not lodged as a standard transaction do not appear.',
      attribution: ATTRIBUTION.ogl,
    };
  }
  return {
    status: 'covered', features: rows,
    latest: rows.slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); })[0] || null,
    attribution: ATTRIBUTION.ogl,
    note: rows.length + ' recorded sale(s) in ' + pc + ', HM Land Registry Price Paid.',
  };
}

// ---------------------------------------------------------------------------
// 5. INSPIRE Index Polygons, through the MHCLG Planning Data Platform
//
// The build brief assumed a monthly bulk download. planning.data.gov.uk serves
// the same registered freehold extents live as the title-boundary dataset,
// 4,250,794 entities nationally, published by HM Land Registry (organisation
// entity 13), quality "authoritative", entry-date 2026-08-03. Verified live
// 2026-08-10. That removes an entire ingest pipeline from the build.
//
// Three quirks the brief is right about and this adapter enforces:
//   An INSPIRE ID is NOT a title number.
//   A title can hold several polygons, each with its own INSPIRE ID.
//   Absence proves nothing: unregistered land, leasehold and other tenures are
//   simply not in the dataset.
// ---------------------------------------------------------------------------
export async function inspireTitleBoundaries(o) {
  const lat = Number(o && o.lat), lon = Number(o && o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 'error', features: [], note: 'A latitude and longitude are required.' };
  }
  const res = await planningDesignations({ lat: lat, lon: lon, datasets: ['title-boundary'], organisationEntity: 13, lpaName: 'HM Land Registry' });
  const band = res.byDataset && res.byDataset['title-boundary'];
  if (!band) return { status: 'error', features: [], note: res.note };

  const rows = (band.features || []).map(function (f) {
    return {
      // The publisher's reference IS the INSPIRE ID. Naming the field
      // inspireId rather than id or reference is deliberate: a consumer must
      // not be able to mistake it for a title number.
      inspireId: f.reference,
      entity: f.entity,
      startDate: f.startDate,
      entryDate: f.entryDate,
      geometry: f.geometry,
      point: f.point,
      // Never null and never omitted. This is the string that stops an
      // indicative extent being read as a legal boundary.
      caveat: ATTRIBUTION.inspireCaveat,
      titleNumber: null,
      titleNumberNote: 'An INSPIRE identifier is not a title number, and one registered title can hold several separate polygons each with its own identifier. The title number is only obtainable from HM Land Registry directly.',
      provenance: 'HM Land Registry INSPIRE Index Polygons, served as the title-boundary dataset by the MHCLG Planning Data Platform. ' + ATTRIBUTION.inspire,
    };
  });

  return {
    status: band.status,
    features: rows,
    // Carried on the response as well as on every row, because a caller that
    // renders the geometry and ignores the rows would otherwise draw a legal
    // looking boundary with no caveat attached to it.
    caveat: ATTRIBUTION.inspireCaveat,
    attribution: ATTRIBUTION.inspire,
    absenceNote: 'A property with no INSPIRE polygon may be unregistered, may be leasehold, or may be a tenure this dataset does not carry. Absence is not evidence of anything.',
    note: rows.length
      ? (rows.length + ' registered freehold extent(s) at this point. ' + ATTRIBUTION.inspireCaveat)
      : ('No registered freehold extent at this point. ' + 'A property with no INSPIRE polygon may be unregistered, leasehold, or another tenure absent from the dataset, so this says nothing about who owns it.'),
  };
}

// ---------------------------------------------------------------------------
// 6. HM Land Registry CCOD and OCOD
//
// CCOD is UK companies that own property. OCOD is overseas companies that own
// property, and it is the single most useful dataset in the whole build for
// the absentee question. Both need an account at
// https://use-land-property-data.service.gov.uk/ and a signed licence per
// dataset. Free, but gated.
//
// API shape verified live 2026-08-10:
//   base    https://use-land-property-data.service.gov.uk/api/v1/{endpoint}
//   auth    the API key in the Authorization header
//   list    GET /datasets
//   meta    GET /datasets/{dataset_name}
//   file    GET /datasets/{dataset_name}/{file_name}
//           returns a signed S3 download_url VALID FOR TEN SECONDS
//   history GET /datasets/history/{dataset_name}
// An unauthenticated call returns HTTP 403 and
// {"error":"Access denied: You need to provide your API Key...","success":false}
//
// Ten seconds is the constraint that shapes this adapter: the download has to
// begin in the same tick the URL is issued, so the URL is never cached, never
// logged and never returned to a caller.
// ---------------------------------------------------------------------------
const HMLR_API = 'https://use-land-property-data.service.gov.uk/api/v1';

export async function hmlrDatasets() {
  const KEY = env('hmlr', 'HMLR', 'HMLR_API_KEY', 'LAND_REGISTRY_KEY');
  if (!KEY) {
    return {
      status: 'no_key', features: [],
      note: 'HM Land Registry is not configured. Set HMLR_API_KEY. CCOD and OCOD also require a signed licence per dataset, accepted in the account at use-land-property-data.service.gov.uk, before the API will serve their files.',
    };
  }
  const r = await getJSON(HMLR_API + '/datasets', { headers: { Authorization: KEY, 'user-agent': UA } }, 8000);
  if (r.status === 403 || r.status === 401) {
    return { status: 'error', features: [], note: 'HM Land Registry refused the key. Check HMLR_API_KEY and that the account has accepted the licence for the datasets in use.' };
  }
  if (!r.ok || !r.json) {
    return { status: 'error', features: [], note: 'HM Land Registry did not answer. HTTP ' + r.status + '.' };
  }
  const list = r.json.result || r.json.datasets || [];
  return {
    status: Array.isArray(list) && list.length ? 'covered' : 'no_coverage',
    features: Array.isArray(list) ? list : [],
    note: Array.isArray(list) && list.length
      ? (list.length + ' HM Land Registry dataset(s) available to this account.')
      : 'The key authenticated but this account has no dataset licences accepted, so no file can be fetched.',
  };
}

// The signed URL lives for ten seconds, so it is fetched and followed inside
// one call and never returned. Callers get the bytes or an honest failure.
export async function hmlrFile(datasetName, fileName) {
  const KEY = env('hmlr', 'HMLR', 'HMLR_API_KEY', 'LAND_REGISTRY_KEY');
  if (!KEY) return { status: 'no_key', body: null, note: 'HM Land Registry is not configured. Set HMLR_API_KEY.' };
  const ds = String(datasetName || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  const fn = String(fileName || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120);
  if (!ds || !fn) return { status: 'error', body: null, note: 'A dataset name and file name are required.' };

  const r = await getJSON(HMLR_API + '/datasets/' + ds + '/' + fn, { headers: { Authorization: KEY, 'user-agent': UA } }, 8000);
  const url = r.json && (r.json.result || {}).download_url;
  if (!r.ok || !url) {
    return {
      status: r.status === 403 ? 'error' : 'no_coverage', body: null,
      // The vendor's message is deliberately not forwarded. It is free text
      // this platform does not control, on a path that carries a credential.
      note: r.status === 403
        ? 'HM Land Registry refused this file. The licence for ' + ds + ' has probably not been accepted on this account.'
        : 'HM Land Registry issued no download URL for ' + ds + '/' + fn + '.',
    };
  }
  // Follow immediately. The URL expires in ten seconds and must not be cached,
  // logged or returned: it is a bearer credential for the file.
  const dl = await fetch(url, { signal: AbortSignal.timeout(20000) }).catch(function () { return null; });
  if (!dl || !dl.ok) {
    return { status: 'error', body: null, note: 'The HM Land Registry download URL was issued but the transfer failed. These URLs expire after ten seconds, so a retry has to request a fresh one.' };
  }
  return { status: 'covered', body: await dl.arrayBuffer(), note: 'Fetched ' + ds + '/' + fn + ' from HM Land Registry.' };
}

// ---------------------------------------------------------------------------
// 7. Companies House
//
// Auth is HTTP Basic with the API key as the username and an empty password.
// Rate limit verified 2026-08-10: 600 requests per five minute window, 429 on
// exceed. That is two per second sustained, which is fine for one block and
// fatal for an uncached sweep, so company records are cached by COMPANY NUMBER
// for 30 days and never fetched per property.
//
// Officer and PSC home addresses are personal data and are never rendered. This
// adapter does not read the officers or PSC endpoints at all: the absentee
// signal is answerable from the company profile alone, and not fetching the
// data is a stronger guarantee than fetching it and promising to redact.
// ---------------------------------------------------------------------------
const CH_TTL = 30 * DAY;

export function normalizeCompany(j) {
  if (!j || typeof j !== 'object') return null;
  const ro = j.registered_office_address || {};
  return {
    companyNumber: j.company_number || null,
    name: j.company_name || null,
    status: j.company_status || null,
    type: j.type || null,
    incorporatedOn: j.date_of_creation || null,
    dissolvedOn: j.date_of_cessation || null,
    // The registered office of a COMPANY is business contact information on a
    // public register, not a person's home address. It is still gated with the
    // other owner fields at the API layer.
    registeredOffice: {
      locality: ro.locality || null,
      region: ro.region || null,
      postcode: ro.postal_code || null,
      country: ro.country || null,
      // Street lines are deliberately dropped. The block model needs the
      // DISTANCE from the asset, which the postcode gives, and nothing in the
      // product needs the street.
    },
    jurisdiction: j.jurisdiction || null,
    sicCodes: Array.isArray(j.sic_codes) ? j.sic_codes.slice(0, 6) : [],
    lastAccountsTo: (j.accounts && j.accounts.last_accounts && j.accounts.last_accounts.made_up_to) || null,
    lastConfirmationTo: (j.confirmation_statement && j.confirmation_statement.last_made_up_to) || null,
    hasCharges: j.has_charges === true ? true : (j.has_charges === false ? false : null),
    provenance: 'Companies House public register, read live. Contains public sector information licensed under the Open Government Licence v3.0.',
  };
}

export async function companiesHouseProfile(companyNumber) {
  const KEY = env('companies_house', 'COMPANIES_HOUSE', 'CH_API_KEY');
  const num = String(companyNumber || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (!num) return { status: 'error', company: null, note: 'A company number is required.' };
  if (!KEY) {
    return {
      status: 'no_key', company: null,
      note: 'Companies House is not configured. Set CH_API_KEY. Without it, a corporate owner name can be shown but nothing can be said about where that company is run from, so the absentee signal stays unknown rather than false.',
    };
  }
  const cached = await memo('pago:uk:ch:' + num, CH_TTL, async function () {
    const auth = 'Basic ' + Buffer.from(KEY + ':').toString('base64');
    const r = await getJSON('https://api.company-information.service.gov.uk/company/' + encodeURIComponent(num),
      { headers: { Authorization: auth, 'user-agent': UA } }, 7000);
    if (r.status === 404) return { notFound: true };
    if (r.status === 429) return { rateLimited: true };
    if (!r.ok || !r.json) return null;
    return { company: normalizeCompany(r.json) };
  });
  if (!cached) return { status: 'error', company: null, note: 'Companies House did not answer for ' + num + '.' };
  if (cached.notFound) return { status: 'no_coverage', company: null, note: 'No company ' + num + ' on the Companies House register.' };
  if (cached.rateLimited) {
    return { status: 'error', company: null, note: 'Companies House rate limit reached. The allowance is 600 requests in five minutes; company records are cached for 30 days, so this clears on its own.' };
  }
  return { status: 'covered', company: cached.company, note: 'Companies House profile for ' + num + '.' };
}

// ---------------------------------------------------------------------------
// 8. VOA non-domestic rating list
//
// BLOCKED, deliberately, and this is not a bug.
//
// Verified 2026-08-10: there is no API. The files sit in Azure Blob Storage at
// voaratinglists.blob.core.windows.net and the container is listable through
// the standard Blob REST interface, which is enough to detect a new epoch. But
// the download page now states the data is "only available under our restricted
// licence", which is a change from the previously open posture.
//
// A human has to read that licence and confirm it permits Cividian's derived
// use before a single row is ingested. Until VOA_LICENCE_ACCEPTED is set by an
// operator who has done that, this resolves to no_key naming the licence as the
// blocker. Shipping a rateable value we are not licensed to publish would be a
// worse failure than not shipping one.
// ---------------------------------------------------------------------------
export async function voaRatingList(/* o */) {
  const accepted = env('voa', 'VOA', 'VOA_LICENCE_ACCEPTED');
  if (!accepted) {
    return {
      status: 'no_key', features: [],
      note: 'Rateable values are not loaded. The Valuation Office Agency publishes the rating list as bulk files under a restricted licence, not as an API, '
        + 'and that licence has to be read and accepted before the data can be ingested or republished. Set VOA_LICENCE_ACCEPTED once an operator has done so. '
        + 'Until then, rateable value and the VOA property description are unknown for every property, which is why no implied value per square foot is offered.',
      blocker: 'licence',
    };
  }
  return {
    status: 'no_coverage', features: [],
    note: 'The VOA licence is marked accepted but no rating list epoch has been ingested in this environment. '
      + 'The container listing at voaratinglists.blob.core.windows.net gives file names, sizes and MD5s for each epoch; an ingest has to load one before values resolve.',
  };
}

// ---------------------------------------------------------------------------
// 9. Energy certificates: Get energy performance of buildings data
//
// The old service retired on 30 May 2026 and epc.opendatacommunities.org now
// 301s to the NEW SERVICE HOMEPAGE, not to a new API path, so a client left
// pointed at the old base URL receives an HTML page where it expects JSON. That
// is why this adapter is pinned to the new host and why nothing here falls back
// to the old one.
//
// Verified live 2026-08-10:
//   api host   https://api.get-energy-performance-data.communities.gov.uk
//   docs host  https://get-energy-performance-data.communities.gov.uk
//              (different hostnames, the api. prefix is easy to miss)
//   auth       Authorization: Bearer <GOV.UK One Login token>, NOT the old
//              HTTP Basic base64 of email:api-key
//   unauth     403 with the body "Access denied. Bad authentication header."
//   search     GET /api/domestic/search, /api/non-domestic/search,
//              /api/display/search
//   filters    postcode, uprn, address, council[], constituency[],
//              efficiency_rating[], date_start, date_end
//   paging     current_page and page_size, 1 to 5000, with a pagination object
//   limit      6000 requests per 5 minutes per originating IP
//
// The field that matters most to the block model is floor area, and DOMESTIC
// AND NON-DOMESTIC DO NOT SPELL IT THE SAME WAY: TOTAL_FLOOR_AREA on a
// domestic certificate, FLOOR_AREA on a non-domestic one. A high street unit
// is non-domestic, so a normalizer that only read the domestic name would
// return null floor area for exactly the buildings this product is about.
// ---------------------------------------------------------------------------
const EPC_API = 'https://api.get-energy-performance-data.communities.gov.uk';
const EPC_TTL = 90 * DAY;

function epcKey() {
  return env('epc', 'EPC', 'EPC_API_KEY', 'EPC_TOKEN');
}

// Reads either the camelCase the JSON API returns or the SNAKE_CASE the data
// dictionary and the bulk downloads use, so one normalizer serves the live API
// and any future ingest.
function pick(rec, names) {
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (rec[n] != null && rec[n] !== '') return rec[n];
    const camel = n.toLowerCase().replace(/_([a-z])/g, function (m, c) { return c.toUpperCase(); });
    if (rec[camel] != null && rec[camel] !== '') return rec[camel];
  }
  return null;
}

export function normalizeEpc(rec, kind) {
  if (!rec || typeof rec !== 'object') return null;
  const nonDomestic = kind === 'non-domestic';
  const areaRaw = nonDomestic
    ? pick(rec, ['FLOOR_AREA', 'TOTAL_FLOOR_AREA'])
    : pick(rec, ['TOTAL_FLOOR_AREA', 'FLOOR_AREA']);
  const area = Number(areaRaw);
  const uprnRaw = pick(rec, ['UPRN']);
  return {
    certificateNumber: pick(rec, ['CERTIFICATE_NUMBER']),
    uprn: uprnRaw != null ? String(uprnRaw).replace(/^0+/, '') : null,
    // How the UPRN got onto the certificate. A UPRN the assessor typed is not
    // the same evidence as one matched from AddressBase, and a block roll that
    // joins on it should be able to tell.
    uprnSource: pick(rec, ['UPRN_SOURCE']),
    postcode: pick(rec, ['POSTCODE']),
    address: pick(rec, ['ADDRESS1', 'ADDRESS']),
    // Zero is not a floor area. A certificate with 0 recorded is a bad record,
    // and passing it through would put a zero into a sum that then reads as a
    // real total.
    floorAreaSqm: Number.isFinite(area) && area > 0 ? Math.round(area) : null,
    floorAreaField: nonDomestic ? 'FLOOR_AREA' : 'TOTAL_FLOOR_AREA',
    rating: nonDomestic
      ? pick(rec, ['ASSET_RATING_BAND', 'CURRENT_ENERGY_EFFICIENCY_BAND', 'CURRENT_ENERGY_RATING'])
      : pick(rec, ['CURRENT_ENERGY_RATING', 'CURRENT_ENERGY_EFFICIENCY_BAND']),
    propertyType: pick(rec, ['PROPERTY_TYPE']),
    builtForm: pick(rec, ['BUILT_FORM']),
    ageBand: pick(rec, ['CONSTRUCTION_AGE_BAND']),
    lodgementDate: pick(rec, ['LODGEMENT_DATE', 'REGISTRATION_DATE']),
    kind: nonDomestic ? 'non-domestic' : 'domestic',
    // Named on every record. This is personal data and the gate depends on
    // downstream code knowing that without having to look it up.
    personalData: true,
    provenance: 'Get energy performance of buildings data, MHCLG, read live. England and Wales. '
      + 'This record is personal data under UK GDPR and the Data Protection Act 2018 and is served only to a signed-in session.',
  };
}

export async function epcSearch(o) {
  const KEY = epcKey();
  if (!KEY) {
    return {
      status: 'no_key', features: [],
      note: 'Energy certificates are not configured. Set EPC_API_KEY to a GOV.UK One Login bearer token for the Get energy performance of buildings data service. '
        + 'The old epc.opendatacommunities.org credentials do not work: that service retired on 30 May 2026 and its HTTP Basic scheme was replaced by a bearer token.',
    };
  }
  const kind = o && o.kind === 'non-domestic' ? 'non-domestic' : (o && o.kind === 'display' ? 'display' : 'domestic');
  const uprn = o && o.uprn ? String(o.uprn).replace(/[^0-9]/g, '').slice(0, 12) : null;
  const postcode = o && o.postcode ? String(o.postcode).trim().toUpperCase() : null;
  if (!uprn && !postcode) return { status: 'error', features: [], note: 'A uprn or a postcode is required.' };

  const params = uprn
    // Twelve digits, zero padded, which is the documented form even though the
    // sample response echoes it as a bare number.
    ? 'uprn=' + encodeURIComponent(uprn.padStart(12, '0'))
    : 'postcode=' + encodeURIComponent(postcode);
  const cacheKey = 'pago:uk:epc:' + kind + ':' + (uprn || postcode);

  const rows = await memo(cacheKey, EPC_TTL, async function () {
    const r = await getJSON(EPC_API + '/api/' + kind + '/search?' + params + '&page_size=100&current_page=1',
      { headers: { Authorization: 'Bearer ' + KEY, accept: 'application/json', 'user-agent': UA } }, 8000);
    if (r.status === 401 || r.status === 403) return { denied: true };
    if (r.status === 429) return { rateLimited: true };
    if (!r.ok || !r.json) return null;
    const data = r.json.data || r.json.rows || r.json.results || [];
    if (!Array.isArray(data)) return null;
    return { rows: data.map(function (d) { return normalizeEpc(d, kind); }).filter(Boolean) };
  });

  if (!rows) return { status: 'error', features: [], note: 'The energy certificate service did not answer. No floor area claim is made.' };
  if (rows.denied) {
    return { status: 'error', features: [], note: 'The energy certificate service refused the token. GOV.UK One Login bearer tokens expire; EPC_API_KEY needs a current one.' };
  }
  if (rows.rateLimited) {
    return { status: 'error', features: [], note: 'The energy certificate service rate limit was reached. The allowance is 6000 requests in five minutes per IP.' };
  }
  if (!rows.rows.length) {
    return {
      status: 'no_coverage', features: [],
      note: 'No ' + kind + ' energy certificate on the register for this ' + (uprn ? 'UPRN' : 'postcode') + '. '
        + 'A certificate is only lodged when a property is built, sold or let, so an absent certificate says the property has not been through one of those events recently. It says nothing about floor area or condition.',
    };
  }
  return {
    status: 'covered', features: rows.rows, kind: kind,
    personalData: true,
    note: rows.rows.length + ' ' + kind + ' energy certificate(s). This is personal data and is gated.',
  };
}

// ---------------------------------------------------------------------------
// 10. Food Standards Agency food hygiene ratings
//
// Free, keyless, and the only free per-address signal of ACTIVE TRADING on a
// high street. Verified live 2026-08-10: the x-api-version header is mandatory
// and a request without it returns 404 rather than an auth error, which is a
// good way to spend an afternoon debugging the wrong thing.
//
// What it is good for and what it is not: a unit with an FHRS record is
// trading, and that is strong. A unit WITHOUT one may be trading in something
// that needs no food registration, which is most of a high street. So its
// absence is one weak signal among several and never a vacancy claim on its
// own, which is why the vacancy engine needs three.
// ---------------------------------------------------------------------------
const FHRS_TTL = 14 * DAY;

export function normalizeFhrs(e) {
  if (!e || typeof e !== 'object') return null;
  const g = e.geocode || {};
  const lat = Number(g.latitude), lon = Number(g.longitude);
  return {
    fhrsId: e.FHRSID != null ? String(e.FHRSID) : null,
    name: e.BusinessName || null,
    businessType: e.BusinessType || null,
    address: [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4].filter(Boolean).join(', ') || null,
    postcode: e.PostCode || null,
    rating: e.RatingValue != null ? String(e.RatingValue) : null,
    ratingDate: e.RatingDate ? String(e.RatingDate).slice(0, 10) : null,
    localAuthority: e.LocalAuthorityName || null,
    point: Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat, lon: lon } : null,
    provenance: 'Food Standards Agency Food Hygiene Rating Scheme, read live. Open Government Licence v3.0. '
      + 'A rating records an inspection, so it evidences trading at the inspection date rather than today.',
  };
}

export async function fhrsNear(o) {
  const lat = Number(o && o.lat), lon = Number(o && o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 'error', features: [], note: 'A latitude and longitude are required.' };
  }
  // The API takes a radius in MILES, not metres. Getting that wrong by a factor
  // of 1600 returns the whole county and looks like it worked.
  const radiusM = Math.max(50, Math.min(parseInt(o.radius, 10) || 200, 2000));
  const miles = Math.max(1, Math.ceil(radiusM / 1609));
  const rl = Math.round(lat * 1e3) / 1e3;
  const rn = Math.round(lon * 1e3) / 1e3;

  const rows = await memo('pago:uk:fhrs:' + rl + ',' + rn + ':' + miles, FHRS_TTL, async function () {
    const r = await getJSON('https://api.ratings.food.gov.uk/Establishments'
      + '?latitude=' + rl + '&longitude=' + rn + '&maxDistanceLimit=' + miles + '&pageSize=200&pageNumber=1',
      { headers: { 'x-api-version': '2', accept: 'application/json', 'user-agent': UA } }, 8000);
    const es = r.json && r.json.establishments;
    if (!r.ok || !Array.isArray(es)) return null;
    return es.map(normalizeFhrs).filter(Boolean);
  });

  if (!rows) return { status: 'error', features: [], note: 'The Food Standards Agency did not answer. No occupancy signal is derived.' };

  // Filter to the requested radius here rather than trusting a mile-rounded
  // query, same discipline as the heritage list.
  const inside = rows.filter(function (e) {
    if (!e.point) return false;
    const dLat = (e.point.lat - lat) * 111320;
    const dLon = (e.point.lon - lon) * 111320 * Math.cos(lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon) <= radiusM;
  });
  return {
    status: 'covered', features: inside,
    attribution: ATTRIBUTION.ogl,
    note: inside.length + ' rated food business(es) within ' + radiusM + ' m. '
      + 'A record evidences trading at the last inspection. Its ABSENCE evidences nothing on its own: most high street uses need no food registration.',
  };
}

// ---------------------------------------------------------------------------
// 11. Historic England funding areas
//
// The build brief expected /api/uk-funding to be entirely curated because there
// is no machine-readable national register of which town got which pot. That is
// still true of the Levelling Up Fund, Towns Fund, Pride in Place and the High
// Streets Strategy. It is NOT true of the two heritage programmes, which
// Historic England publishes as live polygons, verified 2026-08-10:
//
//   layer 0  Heritage Action Zones          NAME, DISTRICT, REGION,
//   layer 1  High Streets Heritage Action   START_YEAR, END_YEAR, STATUS
//            Zones, 69 nationally           (layer 1 also carries UID)
//
// At Whitefriargate both hit: Hull Old Town HAZ 2017 to 2022, and Hull
// Whitefriargate HSHAZ 2020 to 2024, both closed. That is a real funding
// history for the exact street, read live, and it is worth far more than a
// curated row because it carries the dates.
// ---------------------------------------------------------------------------
const FUNDING_SVC = 'https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/Funding_Areas/FeatureServer';
const FUNDING_TTL = 30 * DAY;

export function normalizeFundingArea(f, programme) {
  const a = (f && f.attributes) || {};
  const start = a.START_YEAR != null ? Number(a.START_YEAR) : null;
  const end = a.END_YEAR != null ? Number(a.END_YEAR) : null;
  return {
    programme: programme,
    uid: a.UID || null,
    name: a.NAME || null,
    district: a.DISTRICT || null,
    region: a.REGION || null,
    startYear: Number.isFinite(start) ? start : null,
    endYear: Number.isFinite(end) ? end : null,
    // The register's own word, not a derived one. "Closed" means the programme
    // ended, which is a fact about the funding and not about the buildings.
    status: a.STATUS || null,
    provenance: 'Historic England funding areas, read live. ' + ATTRIBUTION.ogl,
  };
}

export async function fundingAreas(o) {
  const lat = Number(o && o.lat), lon = Number(o && o.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: 'error', features: [], note: 'A latitude and longitude are required.' };
  }
  const rl = Math.round(lat * 1e4) / 1e4;
  const rn = Math.round(lon * 1e4) / 1e4;

  const rows = await memo('pago:uk:funding:' + rl + ',' + rn, FUNDING_TTL, async function () {
    const one = async function (layer, programme) {
      // No outSR, for the same reason as the heritage list: this service family
      // loses features when it reprojects, and these are polygons the map does
      // not need in WGS84 anyway.
      const url = FUNDING_SVC + '/' + layer + '/query'
        + '?geometry=' + encodeURIComponent(rn + ',' + rl)
        + '&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects'
        + '&outFields=*&returnGeometry=false&f=json';
      const r = await getJSON(url, null, 8000);
      if (!r.ok || !r.json || r.json.error || !Array.isArray(r.json.features)) return null;
      return r.json.features.map(function (f) { return normalizeFundingArea(f, programme); });
    };
    const [haz, hshaz] = await Promise.all([one(0, 'Heritage Action Zone'), one(1, 'High Streets Heritage Action Zone')]);
    if (haz == null && hshaz == null) return null;
    return { haz: haz || [], hshaz: hshaz || [], partial: haz == null || hshaz == null };
  });

  if (!rows) {
    return { status: 'error', features: [], note: 'Historic England funding areas did not answer. No funding history claim is made either way.' };
  }
  const all = rows.haz.concat(rows.hshaz);
  return {
    status: rows.partial ? 'no_coverage' : 'covered',
    features: all,
    attribution: ATTRIBUTION.ogl,
    note: rows.partial
      ? 'Only one of the two heritage funding programmes answered, so this funding history is incomplete.'
      : (all.length
        ? (all.length + ' heritage funding programme(s) have covered this point: '
          + all.map(function (a) { return a.name + ' (' + a.programme + ', ' + (a.startYear || '?') + ' to ' + (a.endYear || '?') + ', ' + (a.status || 'status not recorded') + ')'; }).join('; ') + '.')
        : 'No Heritage Action Zone or High Streets Heritage Action Zone has covered this point. These are the only two national funding programmes published as geography; the Levelling Up Fund, Towns Fund and Pride in Place are not, so this is not a complete picture of public money.'),
  };
}
