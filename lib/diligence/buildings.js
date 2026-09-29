// lib/diligence/buildings.js
// The building on the site, read from public footprint data so the brief can
// size an existing structure and tell residential from commercial without the
// user typing either.
//
// Primary: USA Structures, the national building footprint inventory published
// by FEMA with Oak Ridge National Laboratory. Every footprint carries its area,
// an occupancy class (Residential, Commercial, Industrial, ...), usually a
// property address, and the date of the imagery it was traced from.
// Fallback: OpenStreetMap through Overpass, which is volunteered and sparse in
// many Indiana neighborhoods.
//
// Footprints are traced from imagery. They are not surveys, they include
// attached garages and porches, and nothing here describes interior condition.
// Every value is therefore reported as unverified, with its method.
//
// Never throws. A lookup that fails, times out or finds nothing returns
// { ok: false, reason } and the evidence step records an unavailable row.

export const USA_STRUCTURES_URL = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0";
export const USA_STRUCTURES_PAGE = "https://gis-fema.hub.arcgis.com/pages/usa-structures";
export const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const UA = "Cividian/1.0 (+https://www.cividian.com; site diligence)";
const SQFT_PER_SQM = 10.7639;
const MAX_BYTES = 2 * 1024 * 1024;

// Planar area of a lon/lat ring in square meters. An equirectangular
// projection at the ring's own latitude is accurate to well under one percent
// at building scale, far inside the tracing error of the footprint.
export function ringAreaSqm(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  return Math.abs(a) / 2;
}

export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function centroid(ring) {
  const n = ring.length - 1 || 1;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

function meters(a, b) {
  const kx = 111320 * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540);
}

function parcelRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((p) => p[0]);
  return [];
}

function closed(ring) {
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
  return ring;
}

const SUFFIX = { STREET: "ST", AVENUE: "AVE", ROAD: "RD", DRIVE: "DR", BOULEVARD: "BLVD", LANE: "LN", COURT: "CT", PLACE: "PL", PARKWAY: "PKWY", HIGHWAY: "HWY", TERRACE: "TER", CIRCLE: "CIR", NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };
// "5009 Fletcher Street" and "5009 FLETCHER ST, ANDERSON" normalize alike.
export function addressKey(value) {
  const first = String(value || "").split(",")[0].toUpperCase().replace(/[^A-Z0-9 ]/g, " ").trim().split(/\s+/).map((w) => SUFFIX[w] || w);
  return /^\d/.test(first[0] || "") && first.length > 1 ? first.join(" ") : null;
}

// Choose the site's building. Preference: the footprint whose recorded address
// matches the query or parcel address; else one containing the site point;
// else the largest whose centroid sits in the parcel polygon; else the nearest
// within 35 m of the point.
export function pickBuilding(candidates, point, parcelGeometry, addresses = []) {
  const rings = parcelRings(parcelGeometry);
  const keys = addresses.map(addressKey).filter(Boolean);
  const list = (candidates || []).filter((c) => c && Array.isArray(c.ring) && c.ring.length >= 4).map((c) => {
    const ring = closed(c.ring.slice()), cen = centroid(ring);
    return { ...c, ring, areaSqm: c.areaSqm != null ? c.areaSqm : ringAreaSqm(ring), centroid: cen, distanceM: meters([point.lon, point.lat], cen) };
  }).filter((c) => c.areaSqm != null && c.areaSqm >= 8 && !c.outbuilding);
  const byAddress = keys.length ? list.filter((c) => c.address && keys.includes(addressKey(c.address))).sort((a, b) => a.distanceM - b.distanceM)[0] : null;
  if (byAddress && byAddress.distanceM <= 150) return { ...byAddress, match: "address" };
  const containing = list.find((c) => pointInRing(point.lon, point.lat, c.ring));
  if (containing) return { ...containing, match: "contains_point" };
  const inParcel = list.filter((c) => rings.some((r) => pointInRing(c.centroid[0], c.centroid[1], r))).sort((a, b) => b.areaSqm - a.areaSqm)[0];
  if (inParcel) return { ...inParcel, match: "inside_parcel" };
  const nearest = list.sort((a, b) => a.distanceM - b.distanceM)[0];
  if (nearest && nearest.distanceM <= 35) return { ...nearest, match: "nearest" };
  return null;
}

function num(v, lo, hi) {
  const n = Number.parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > lo && n < hi ? n : null;
}

function yearTag(tags) {
  for (const k of ["start_date", "building:start_date", "construction_date"]) {
    const m = /(1[6-9]\d\d|20\d\d)/.exec(String(tags[k] || ""));
    if (m) return Number(m[1]);
  }
  return null;
}

export function fromUsaStructures(features) {
  return (features || []).filter((f) => f && f.geometry && Array.isArray(f.geometry.rings) && f.geometry.rings[0]).map((f) => {
    const a = f.attributes || {};
    return {
      provider: "usa_structures", id: a.BUILD_ID || a.OBJECTID, ring: f.geometry.rings[0].map((p) => [p[0], p[1]]),
      areaSqm: num(a.SQMETERS, 0, 1e7), address: a.PROP_ADDR || null, occupancy: a.OCC_CLS || null, primaryUse: a.PRIM_OCC || null,
      heightM: num(a.HEIGHT, 1, 700), imageDate: a.IMAGE_DATE ? new Date(a.IMAGE_DATE).toISOString().slice(0, 10) : null,
      outbuilding: !!a.OUTBLDG && String(a.OUTBLDG).toUpperCase() !== "N", tags: {},
    };
  });
}

export function fromOverpass(elements) {
  return (elements || []).filter((e) => e && e.type === "way" && Array.isArray(e.geometry) && e.tags && e.tags.building).map((e) => ({
    provider: "openstreetmap", id: e.id, ring: e.geometry.map((g) => [g.lon, g.lat]), areaSqm: null,
    address: e.tags["addr:housenumber"] && e.tags["addr:street"] ? e.tags["addr:housenumber"] + " " + e.tags["addr:street"] : null,
    occupancy: null, primaryUse: e.tags.building !== "yes" ? String(e.tags.building) : null, heightM: num(e.tags.height, 1, 700),
    levels: num(e.tags["building:levels"], 0, 200), yearBuilt: yearTag(e.tags), imageDate: null, outbuilding: false, tags: e.tags,
  }));
}

export function describeBuilding(b) {
  const levels = b.levels != null ? b.levels : null;
  const footprintSqft = Math.round(b.areaSqm * SQFT_PER_SQM);
  const isUsa = b.provider === "usa_structures";
  return {
    ok: true,
    provider: b.provider,
    sourceName: isUsa ? "USA Structures (FEMA and Oak Ridge National Laboratory)" : "OpenStreetMap building footprints (Overpass API)",
    url: isUsa ? USA_STRUCTURES_PAGE : "https://www.openstreetmap.org/way/" + b.id,
    buildingId: String(b.id),
    match: b.match,
    distanceM: Math.round(b.distanceM),
    address: b.address,
    occupancy: b.occupancy,
    primaryUse: b.primaryUse,
    footprintSqft,
    levels,
    heightM: b.heightM,
    grossSqftEstimate: levels ? Math.round(footprintSqft * levels) : null,
    yearBuilt: b.yearBuilt || null,
    imageDate: b.imageDate || null,
    name: b.tags && typeof b.tags.name === "string" ? b.tags.name.slice(0, 120) : null,
  };
}

async function readJson(fetchImpl, url, init, timeoutMs) {
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!r || !r.ok) throw Object.assign(new Error("http " + (r ? r.status : "none")), { reason: "http_" + (r ? r.status : "none") });
  const text = await r.text();
  if (text.length > MAX_BYTES) throw Object.assign(new Error("too large"), { reason: "response_too_large" });
  return JSON.parse(text);
}

async function usaStructures(fetchImpl, point, timeoutMs) {
  const qs = new URLSearchParams({ geometry: point.lon.toFixed(6) + "," + point.lat.toFixed(6), geometryType: "esriGeometryPoint", inSR: "4326", distance: "60", units: "esriSRUnit_Meter", spatialRel: "esriSpatialRelIntersects", outFields: "BUILD_ID,OBJECTID,OCC_CLS,PRIM_OCC,PROP_ADDR,HEIGHT,SQMETERS,IMAGE_DATE,OUTBLDG", returnGeometry: "true", outSR: "4326", resultRecordCount: "60", f: "json" });
  const j = await readJson(fetchImpl, USA_STRUCTURES_URL + "/query?" + qs, { headers: { "user-agent": UA } }, timeoutMs);
  if (j.error) throw Object.assign(new Error("arcgis error"), { reason: "arcgis_error" });
  return fromUsaStructures(j.features);
}

async function overpass(fetchImpl, point, timeoutMs) {
  const q = "[out:json][timeout:8];way[\"building\"](around:60," + point.lat.toFixed(6) + "," + point.lon.toFixed(6) + ");out tags geom;";
  let last = null;
  for (const url of OVERPASS_URLS) {
    try {
      const j = await readJson(fetchImpl, url, { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) }, timeoutMs);
      if (typeof j.remark === "string" && /error/i.test(j.remark)) throw Object.assign(new Error("overpass remark"), { reason: "overpass_runtime_error" });
      return fromOverpass(j.elements);
    } catch (e) { last = e; }
  }
  throw last || new Error("overpass unavailable");
}

export async function fetchBuilding(point, parcelGeometry, opts = {}) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return { ok: false, reason: "no_point" };
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 8000;
  const addresses = (opts.addresses || []).filter(Boolean);
  const reasons = [];
  for (const [name, read] of [["usa_structures", usaStructures], ["openstreetmap", overpass]]) {
    try {
      const b = pickBuilding(await read(fetchImpl, point, timeoutMs), point, parcelGeometry, addresses);
      if (b) return { ...describeBuilding(b), retrievedAt: new Date().toISOString() };
      reasons.push(name + ": no building mapped at this site");
    } catch (e) {
      reasons.push(name + ": " + (e && e.name === "TimeoutError" ? "timed out" : String((e && e.reason) || "unavailable").replace(/_/g, " ")));
    }
  }
  return { ok: false, reason: reasons.join("; ") };
}
