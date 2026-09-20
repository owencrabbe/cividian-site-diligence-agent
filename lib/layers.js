// lib/layers.js
// Live inputs for the Access, Activity, and Power layers of the Cividian Score.
//
// Design rules (see AGENTS.md section 8):
// - Every external read degrades to null and the layer stays PENDING.
//   A failed fetch is never converted into a plausible number.
// - Everything is cached (these signals move slowly; 30 days) so external
//   providers are hit once per city, not once per pageview.
// - Each scored layer returns a provenance string: source, vintage, method.
//   Provenance is what makes the score defensible in front of an investor.

import { getJSON, setJSON } from "./store.js";
import { CITIES } from "../data/cities.js";
import { fieldIntelFor } from "../data/field-intel.js";

const UA = "Cividian/1.0 (contact: " + (process.env.CONTACT_EMAIL || "contact@cividian.com") + ")";
const DAY = 24 * 3600;
const LAYER_TTL = 30 * DAY; // successful provider reads move slowly
const MISS_TTL = 6 * 3600; // failed reads retry within hours, not per request

// memo(): cache hits long, cache misses short. A provider outage degrades to
// an honest pending layer and is retried later; it is never converted into a
// number and never re-fetched on every pageview.
async function memo(key, producer) {
  try {
    const hit = await getJSON(key);
    if (hit) return hit.miss ? null : hit.v;
  } catch {}
  let v = null;
  try {
    v = await producer();
  } catch {
    v = null;
  }
  try {
    await setJSON(key, v == null ? { miss: true } : { v }, v == null ? MISS_TTL : LAYER_TTL);
  } catch {}
  return v;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
async function fetchText(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Coordinates: seed list first, then cached OSM Nominatim. Null when unknown.
// ---------------------------------------------------------------------------
export function seedCoords(name, state) {
  if (!name || !state) return null;
  const n1 = String(name).trim().toLowerCase();
  const s1 = String(state).trim().toLowerCase();
  const hit = CITIES.find(
    (c) => c[0].toLowerCase() === n1 && c[1].toLowerCase() === s1
  );
  return hit ? { lat: hit[4], lon: hit[5] } : null;
}

export async function resolveCoords(name, state, latQ, lonQ) {
  const lat = num(latQ), lon = num(lonQ);
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { lat, lon };
  }
  const seed = seedCoords(name, state);
  if (seed) return seed;
  const key = "pago:geo:" + String(name).toLowerCase() + ":" + String(state).toLowerCase();
  return memo(key, async () => {
    const q = encodeURIComponent(name + ", " + state + ", USA");
    const txt = await fetchText(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + q,
      6000
    );
    if (!txt) return null;
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr) || !arr[0]) return null;
    const la = num(arr[0].lat), lo = num(arr[0].lon);
    return la != null && lo != null ? { lat: la, lon: lo } : null;
  });
}

// ---------------------------------------------------------------------------
// ACCESS: physical market access from OpenStreetMap via Overpass.
// Counts three verifiable things around the city center:
//   interstate/motorway junctions within 15 km  (highway access)
//   rail + bus stations within 10 km            (transit access)
//   IATA-coded airports within 40 km            (air access)
// ---------------------------------------------------------------------------
export async function fetchAccessSignals(lat, lon) {
  if (lat == null || lon == null) return null;
  const rl = Math.round(lat * 100) / 100;
  const rn = Math.round(lon * 100) / 100;
  const key = "pago:layer:access:" + rl + ":" + rn;
  return memo(key, async () => {
      const q =
        '[out:json][timeout:15];' +
        'node["highway"="motorway_junction"](around:15000,' + rl + "," + rn + ");out count;" +
        '(node["railway"="station"](around:10000,' + rl + "," + rn + ");" +
        'node["public_transport"="station"](around:10000,' + rl + "," + rn + ");" +
        'node["amenity"="bus_station"](around:10000,' + rl + "," + rn + "););out count;" +
        '(node["aeroway"="aerodrome"]["iata"](around:40000,' + rl + "," + rn + ");" +
        'way["aeroway"="aerodrome"]["iata"](around:40000,' + rl + "," + rn + "););out count;";
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: {
            "user-agent": UA,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "data=" + encodeURIComponent(q),
          signal: ctl.signal,
        });
        if (!r.ok) return null;
        const j = await r.json();
        const counts = (j.elements || [])
          .filter((e) => e.type === "count")
          .map((e) => parseInt((e.tags && e.tags.total) || "0", 10) || 0);
        if (counts.length !== 3) return null;
        return {
          junctions: counts[0],
          stations: counts[1],
          airports: counts[2],
          fetchedAt: new Date().toISOString().slice(0, 10),
        };
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
  });
}

export function scoreAccess(sig) {
  if (!sig || sig.junctions == null) return null;
  const s = clamp(
    Math.round(
      25 +
        clamp(sig.junctions * 2.5, 0, 35) +
        clamp(sig.stations * 3, 0, 20) +
        clamp(sig.airports * 8, 0, 16)
    ),
    0,
    100
  );
  return {
    score: s,
    provenance:
      "OpenStreetMap via Overpass API, read " + sig.fetchedAt + ". Method: " +
      sig.junctions + " interstate junctions within 15 km, " +
      sig.stations + " rail or bus stations within 10 km, " +
      sig.airports + " IATA airports within 40 km of city center.",
  };
}

// ---------------------------------------------------------------------------
// ACTIVITY: residential building-permit momentum from the US Census Building
// Permits Survey place-level files (public, no key). Latest full year vs the
// prior year. A non-reporting place (0 months reported) stays pending; zero
// reported permits from a reporting place is a real zero.
// ---------------------------------------------------------------------------
const BPS_REGION = {
  "09": "ne", "23": "ne", "25": "ne", "33": "ne", "44": "ne", "50": "ne", "34": "ne", "36": "ne", "42": "ne",
  "17": "mw", "18": "mw", "26": "mw", "39": "mw", "55": "mw", "19": "mw", "20": "mw", "27": "mw", "29": "mw", "31": "mw", "38": "mw", "46": "mw",
  "10": "so", "11": "so", "12": "so", "13": "so", "24": "so", "37": "so", "45": "so", "51": "so", "54": "so", "01": "so", "21": "so", "28": "so", "47": "so", "05": "so", "22": "so", "40": "so", "48": "so",
  "04": "we", "08": "we", "16": "we", "30": "we", "32": "we", "35": "we", "49": "we", "56": "we", "02": "we", "06": "we", "15": "we", "41": "we", "53": "we",
};
const BPS_DIR = { mw: "Midwest%20Region", ne: "Northeast%20Region", so: "South%20Region", we: "West%20Region" };

// Pure parser, unit-testable without network. Columns (0-based, no quoted
// fields in these files): 1 state FIPS, 5 FIPS place, 15 months reported,
// units at 18 (1-unit), 21 (2-unit), 24 (3-4), 27 (5+), values at 19/22/25/28.
export function parseBpsUnits(text, stateFips, placeFips) {
  if (!text) return null;
  const st = String(stateFips).trim();
  const pl = String(placeFips).trim();
  let units = 0, value = 0, monthsRep = 0, found = false;
  const lines = text.split("\n");
  for (let i = 2; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 28) continue;
    if (p[1].trim() !== st || p[5].trim() !== pl) continue;
    found = true;
    monthsRep = Math.max(monthsRep, parseInt(p[15], 10) || 0);
    for (const ui of [18, 21, 24, 27]) units += parseInt(p[ui], 10) || 0;
    for (const vi of [19, 22, 25, 28]) value += parseInt(p[vi], 10) || 0;
  }
  return found ? { units, value, monthsRep } : null;
}

async function bpsYear(region, year) {
  const yy = String(year).slice(2);
  const url =
    "https://www2.census.gov/econ/bps/Place/" + BPS_DIR[region] + "/" +
    region + yy + "12y.txt";
  return fetchText(url, 9000);
}

export async function fetchActivitySignals(stateFips, placeFips) {
  if (!stateFips || !placeFips) return null;
  const region = BPS_REGION[String(stateFips).trim()];
  if (!region) return null;
  const key = "pago:layer:bps:" + stateFips + ":" + placeFips;
  return memo(key, async () => {
      const nowYear = new Date().getUTCFullYear();
      let year = nowYear - 1;
      let latestTxt = await bpsYear(region, year);
      if (!latestTxt) {
        year = nowYear - 2;
        latestTxt = await bpsYear(region, year);
      }
      if (!latestTxt) return null;
      const latest = parseBpsUnits(latestTxt, stateFips, placeFips);
      if (!latest || latest.monthsRep === 0) return null;
      let prior = null;
      const priorTxt = await bpsYear(region, year - 1);
      if (priorTxt) {
        const p = parseBpsUnits(priorTxt, stateFips, placeFips);
        if (p && p.monthsRep > 0) prior = p;
      }
      return {
        units: latest.units,
        value: latest.value,
        unitsPrior: prior ? prior.units : null,
        year,
        priorYear: prior ? year - 1 : null,
      };
  });
}

export function scoreActivity(sig, population) {
  if (!sig || sig.units == null || population == null || population <= 0) return null;
  const per1k = Math.round((sig.units / population) * 10000) / 10;
  let s = 30 + clamp(per1k * 8, 0, 40);
  let momentumNote = "";
  if (sig.unitsPrior != null) {
    const growth = (sig.units - sig.unitsPrior) / Math.max(sig.unitsPrior, 1);
    s += clamp(growth * 25, -15, 25);
    momentumNote =
      " vs " + sig.unitsPrior + " in " + sig.priorYear +
      " (" + (growth >= 0 ? "+" : "") + Math.round(growth * 100) + "%)";
  }
  return {
    score: clamp(Math.round(s), 0, 100),
    provenance:
      "US Census Building Permits Survey, place-level, " + sig.year +
      " annual. Method: " + sig.units + " residential units permitted (" +
      per1k + " per 1,000 residents)" + momentumNote + ".",
  };
}

// ---------------------------------------------------------------------------
// POWER: Cividian field intelligence, structured and sourced per city.
// No entry means an honest pending layer.
// ---------------------------------------------------------------------------
export function scorePower(name, state) {
  const e = fieldIntelFor(name, state);
  if (!e) return null;
  const s = clamp(
    Math.round(
      0.4 * e.incentiveAggressiveness +
        0.35 * e.politicalWill +
        0.25 * (100 - e.entitlementFriction)
    ),
    0,
    100
  );
  return {
    score: s,
    provenance:
      "Cividian field intelligence, as of " + e.asOf +
      ". Inputs: incentive aggressiveness, entitlement friction, political will. Sources: " +
      e.sources.join("; ") + ".",
  };
}

// ---------------------------------------------------------------------------
// Assembly: fetch what can be fetched inside a hard time budget. Anything
// that misses the budget stays pending on this request and will usually be
// cache-warm on the next one.
// ---------------------------------------------------------------------------
export async function liveLayers({ name, state, lat, lon, stateFips, placeFips, population, budgetMs }) {
  const budget = budgetMs || 10000;
  const out = { access: null, activity: null, power: null };
  try {
    out.power = scorePower(name, state);
  } catch {
    out.power = null;
  }
  try {
    const coordsP = resolveCoords(name, state, lat, lon);
    const [coords, activitySig] = await Promise.all([
      withTimeout(coordsP, Math.min(6000, budget)),
      withTimeout(fetchActivitySignals(stateFips, placeFips), budget),
    ]);
    let accessSig = null;
    if (coords) {
      accessSig = await withTimeout(fetchAccessSignals(coords.lat, coords.lon), budget);
    }
    out.access = scoreAccess(accessSig);
    if (out.access) out.access.signals = accessSig;
    out.activity = scoreActivity(activitySig, population);
    if (out.activity) out.activity.signals = activitySig;
  } catch {
    // layers stay pending; never fabricated
  }
  return out;
}
