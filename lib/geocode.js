// lib/geocode.js
// Resolve a "City, State" or a street address to lat/lon with a real fallback
// chain so a single vendor cannot take the map down (Five Forces supplier-risk
// fix).
//   1) Mapbox (if token set) -> precise, fast
//   2) OpenStreetMap Nominatim (free, no key) -> fallback when Mapbox is absent or empty
//
// Pure resolver: no req, no res, and it never throws. Lifted out of
// api/geocode.js so the HTTP endpoint, the public API surface, and any
// server-side render can share one lookup instead of re-implementing the
// fallback chain and the cache key three times.
import crypto from 'crypto';
import { getKey, setKeyEx } from './redis.js';

// Addresses and city centroids do not move, so a resolved lookup is cached for
// 30 days. Repeat searches for the same place then cost nothing at the vendor.
const GEOCODE_TTL = 30 * 24 * 3600;

// Kept as-is rather than switched to fetchWithTimeout from lib/http.js. Two
// properties here are load-bearing and the shared helper has neither: the abort
// stays armed across the JSON body read (not just until headers arrive), and a
// non-JSON or truncated body resolves to { ok: false, json: null } instead of
// throwing, which is what makes the Mapbox -> Nominatim fallback below a
// fallback rather than an error path. Verified against both call sites.
async function fetchJSON(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || 7000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    const j = await r.json();
    return { ok: r.ok, json: j };
  } catch (e) {
    return { ok: false, json: null };
  } finally { clearTimeout(t); }
}

async function viaMapbox(q, wantAddress) {
  const tok = process.env.mapbox || process.env.MAPBOX || process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN;
  if (!tok) return null;
  // A query with a street number is a property lookup, not a city lookup.
  const types = wantAddress ? 'address,place,poi' : 'place';
  const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(q) + '.json?types=' + types + '&limit=1&country=us&access_token=' + encodeURIComponent(tok);
  const r = await fetchJSON(url);
  const f = r.json && r.json.features && r.json.features[0];
  if (!f) return null;
  // Surface the containing city/state so the client can bind city context to
  // an address hit. Mapbox carries them in the context chain.
  let city = null, state = null;
  try {
    (f.context || []).forEach(function (c) {
      if (/^place\./.test(c.id)) city = c.text;
      if (/^region\./.test(c.id)) state = c.text;
    });
    if (!city && /^place\./.test(f.id || '')) city = f.text;
  } catch (e) {}
  return { ok: true, lon: f.center[0], lat: f.center[1], bbox: f.bbox || null, place: f.place_name, city: city, state: state, kind: wantAddress ? 'address' : 'place', source: 'mapbox' };
}

async function viaNominatim(q, wantAddress) {
  // OSM usage policy requires a descriptive User-Agent and modest rate.
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=us&q=' + encodeURIComponent(q);
  const r = await fetchJSON(url, { headers: { 'User-Agent': 'Cividian-CityIntelligence/1.0 (contact: ' + (process.env.CONTACT_EMAIL || 'contact@cividian.com') + ')' } }, 8000);
  const f = Array.isArray(r.json) && r.json[0];
  if (!f) return null;
  let bbox = null;
  if (f.boundingbox && f.boundingbox.length === 4) {
    // Nominatim boundingbox is [south, north, west, east] -> convert to [west, south, east, north]
    const bb = f.boundingbox.map(parseFloat);
    bbox = [bb[2], bb[0], bb[3], bb[1]];
  }
  const a = f.address || {};
  const city = a.city || a.town || a.village || a.hamlet || null;
  const state = a.state || null;
  return { ok: true, lon: parseFloat(f.lon), lat: parseFloat(f.lat), bbox: bbox, place: f.display_name, city: city, state: state, kind: wantAddress ? 'address' : 'place', source: 'osm' };
}

// Returns { ok: true, lat, lon, bbox, place, city, state, kind, source } plus
// cached: true on a Redis hit, or { ok: false, error } for the three honest
// failures: 'q required', 'not found', 'lookup unavailable'. Never throws, so
// callers do not need a guard of their own.
export async function geocodeLookup(q, opts) {
  const o = opts || {};
  // Length-limit before the value is sent to a paid vendor or used as a cache
  // key: an unbounded query is wasted quota and a storage-key abuse vector.
  const term = String(q || '').trim().slice(0, 200);
  if (!term) return { ok: false, error: 'q required' };
  // Explicit mode 'address', or any query carrying a street number, geocodes as
  // a property address (Zillow-style lookup) instead of a city.
  const wantAddress = String(o.mode || '') === 'address' || /\d/.test(term);
  // The key is a HASH of the term, not the term. Two reasons, both real: the
  // cache is written on every successful lookup with a 30-day life and the term
  // is up to 200 characters of arbitrary caller input, so a caller varying the
  // query wrote an unbounded number of long-lived keys into the store; and a
  // fixed-width digest keeps caller-controlled text out of a store key entirely,
  // which is the same discipline api/v1.js applies to path segments. Collisions
  // are not a concern at 96 bits over a cache.
  const digest = crypto.createHash('sha1').update(term.toLowerCase(), 'utf8').digest('hex').slice(0, 24);
  const ck = 'pago:geocode:' + (wantAddress ? 'a:' : 'c:') + digest;
  try {
    const hit = await getKey(ck);
    if (hit && hit.ok) return Object.assign({}, hit, { cached: true });
  } catch (e) {}
  try {
    let out = await viaMapbox(term, wantAddress);
    if (!out) out = await viaNominatim(term, wantAddress);
    if (!out) return { ok: false, error: 'not found' };
    try { await setKeyEx(ck, out, GEOCODE_TTL); } catch (e) {}
    return out;
  } catch (e) {
    // Last resort: try the free provider even if the primary threw.
    try { const fb = await viaNominatim(term, wantAddress); if (fb) return fb; } catch (e2) {}
    console.log('PAGO_GEOCODE_ERR ' + String((e && e.message) || e));
    return { ok: false, error: 'lookup unavailable' };
  }
}
