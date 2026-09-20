// lib/history.js
// The monthly observation reader, lifted out of api/history.js so the member
// endpoint and the versioned API read frozen history through one path. The
// snapshot writer freezes each place once per calendar month; this reads those
// months back, newest first, by probing the deterministic month keys directly
// rather than trusting an index, so a lost index entry can never hide a real
// snapshot.
//
// History begins at a place's first verified read. Nothing is backfilled,
// reconstructed, or interpolated, and a young ledger says so in words instead
// of letting two points imply a trend.

import { getKey } from "./redis.js";
import { stateFips } from "./fips.js";

// The place segment of an observation key. It lives here, exported, because the
// writer in lib/citydata.js and this reader MUST agree, and they did not: the
// writer used the caller's raw spelling, so "St. Louis" from /api/city and
// "st louis" from the slug-derived /intel route froze two permanent, divergent
// history streams for one city, and a lookup under either spelling reported "no
// frozen months yet for this place" about a place that had months. That sentence
// is stated as a positive finding about the place, not as a lookup miss, which
// makes it the worst kind of wrong.
//
// The collapse is the same one readCityBase already uses to match the Census
// place list, so a spelling that resolves to one Census place resolves to one
// observation key. Simple names are unchanged by it, so existing frozen months
// under "muncie" or "anderson" keep resolving; only the punctuated spellings,
// which are exactly the broken ones, move.
export function obsPlaceKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function monthList(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

// Returns an envelope, never throws on bad input: a missing name or state and
// an unrecognized state are ordinary answers, not failures. A store outage does
// throw, and each caller decides how to report that (the endpoint logs it and
// answers honestly rather than 500ing).
export async function readHistory(name, state, maxMonths) {
  const city = String(name || "").trim().slice(0, 80);
  const st = String(state || "").trim().slice(0, 40);
  if (!city || !st) return { ok: false, error: "city and state required" };
  const fips = stateFips(st);
  if (!fips) return { ok: false, error: "unknown state" };

  const place = obsPlaceKey(city);
  const months = [];
  for (const m of monthList(maxMonths)) {
    const snap = await getKey("pago:obs:" + fips + ":" + place + ":" + m);
    // The schema check is the gate: only rows this code knows how to read are
    // reported, so an older or foreign shape is skipped rather than half read.
    if (snap && snap.schema === "cityobs.v1") {
      months.push({
        month: snap.month,
        score: snap.score,
        comparisonSignature: snap.comparisonSignature || null,
        verdict: snap.verdict || null,
        liveWeightShare: snap.liveWeightShare != null ? snap.liveWeightShare : null,
        population: snap.population != null ? snap.population : null,
        medianIncome: snap.medianIncome != null ? snap.medianIncome : null,
        medianHomeValue: snap.medianHomeValue != null ? snap.medianHomeValue : null,
        vacancyPct: snap.vacancyPct != null ? snap.vacancyPct : null,
        source: snap.source || null,
        asOf: snap.asOf || null,
        scoreModelVersion: snap.scoreModelVersion || null,
        census: snap.census || null,
        frozenAt: snap.ts || null,
      });
    }
  }
  return {
    ok: true,
    city,
    state: st,
    months,
    note: months.length === 0
      ? "No frozen months yet for this place. History begins with the first verified read and accumulates monthly; nothing is backfilled."
      : months.length < 3
        ? "A young record: " + months.length + " frozen month" + (months.length === 1 ? "" : "s") + " so far. Trend claims need more history than this."
        : null,
    basis: "Each row is the best-resolved served reading retained for that month; its timestamp may advance when coverage improves. Do not interpret changes in model, coverage or overlapping ACS vintages as market growth. Source: US Census ACS via Cividian monthly observations.",
  };
}
