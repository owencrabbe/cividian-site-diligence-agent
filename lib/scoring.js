// lib/scoring.js
// Cividian Score, computed server-side. The formula does not ship in browser JS;
// the client receives the number, the layer breakdown, and provenance.
//
// Published weighting: People 25, Money 22, Land 18, Access 15, Power 12,
// Activity 8. People/Money/Land are computed from Census ACS. Access,
// Activity, and Power are computed ONLY when their live inputs resolve
// (lib/layers.js). A pending layer is excluded from the weighted total and
// the remaining weights are renormalized, which is the honest treatment:
// the score reflects what is known, and the breakdown says what is not.
import { createCityDecision } from './decision.js';
import { recordVintage } from './census.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Each ACS layer scores from a base constant that is adjusted by whatever
// inputs resolved. That base is a REFERENCE POINT, not a reading, so a layer
// whose own inputs all came back null must return null rather than the bare
// base: otherwise a place the Census matched by name but published no values
// for would score 52 and return PASS, with layerStatus claiming "live_acs" over
// a read that produced nothing. Census suppresses values for small places
// routinely, so this is the common case at the small end of the market, which
// is the end Cividian exists to cover. The guard is per layer rather than
// global because a partial read is still a real read: a place with a published
// population and a suppressed median income keeps its money layer and loses
// only what was actually missing.
function peopleScore(d) {
  // Income relative to a ~$55k reference, vacancy penalty, affordability.
  if (d.medianIncome == null && d.vacancyPct == null && d.medianHomeValue == null) return null;
  let s = 50;
  if (d.medianIncome != null) {
    s += clamp((d.medianIncome - 55000) / 2500, -15, 20);
  }
  if (d.vacancyPct != null) {
    s += clamp(10 - d.vacancyPct, -12, 12);
  }
  if (d.medianHomeValue != null) {
    s += clamp((220000 - d.medianHomeValue) / 15000, -8, 12);
  }
  return clamp(Math.round(s), 0, 100);
}

function moneyScore(d) {
  // Lower home values + meaningful population => stronger incentive case.
  if (d.population == null && d.medianHomeValue == null) return null;
  let s = 55;
  if (d.population != null) s += clamp((d.population - 40000) / 8000, -10, 15);
  if (d.medianHomeValue != null)
    s += clamp((180000 - d.medianHomeValue) / 20000, -8, 12);
  return clamp(Math.round(s), 0, 100);
}

function landScore(d) {
  if (d.vacancyPct == null) return null;
  let s = 50;
  s += clamp(d.vacancyPct - 6, -6, 18); // some vacancy = opportunity
  return clamp(Math.round(s), 0, 100);
}

function peopleComplete(d) {
  return d.medianIncome != null && d.vacancyPct != null && d.medianHomeValue != null;
}
function moneyComplete(d) {
  return d.population != null && d.medianHomeValue != null;
}

const WEIGHTS = {
  people: 0.25,
  money: 0.22,
  land: 0.18,
  access: 0.15,
  power: 0.12,
  activity: 0.08,
};

// The floor under a COMPOSITE score. Renormalizing over resolved layers is the
// honest arithmetic, but it says nothing about whether enough was resolved to
// warrant a single number and a verdict sentence. It is not: with a published
// population and everything else suppressed, only Money resolves at 0.22, the
// renormalized score BECOMES the money layer, and a place whose one known fact
// is a headcount comes back 70 / PURSUE / "strong fundamentals, open window".
// That asserts something about fundamentals that were never read, and PURSUE
// moves capital, so it is worse than the 52 / PASS this file already refuses.
// 0.40 excludes every single layer; a pair must still carry enough combined
// weight (Access + Activity alone, for example, carries only 0.23). Below the
// floor the LAYERS still ship, with their real values and their
// real statuses, because a partial read is still a real read. Only the
// composite, which is the part that would be a conclusion, is withheld.
const MIN_SCORE_WEIGHT = 0.40;

// live = { access: {score, provenance}|null,
//          activity: {score, provenance}|null,
//          power: {score, provenance}|null }  (from lib/layers.js)
export function computeScore(d, live) {
  // Reject invalid cached/provider numbers without converting a missing value
  // or a string to zero. A real zero is preserved in scoring and evidence.
  d = { ...(d || {}) };
  for (const key of ['population', 'medianIncome', 'medianHomeValue', 'vacancyPct']) {
    const value = d[key];
    d[key] = Number.isFinite(value) && value >= 0 && (key !== 'vacancyPct' || value <= 100) ? value : null;
  }
  const lv = {};
  for (const key of ['access', 'power', 'activity']) {
    const value = live && live[key];
    lv[key] = value && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100 &&
      typeof value.provenance === 'string' && value.provenance.trim() ? value : null;
  }
  const layers = {
    people: peopleScore(d),
    money: moneyScore(d),
    land: landScore(d),
    access: lv.access ? lv.access.score : null,
    power: lv.power ? lv.power.score : null,
    activity: lv.activity ? lv.activity.score : null,
  };
  // partial_acs is its own status because "live_acs" over one of three published
  // inputs claims a completeness the read did not have, and a consumer keying on
  // the status has no other way to tell the two apart.
  const layerStatus = {
    people: layers.people == null ? "pending_acs_values" : (peopleComplete(d) ? "live_acs" : "partial_acs"),
    money: layers.money == null ? "pending_acs_values" : (moneyComplete(d) ? "derived_from_acs" : "partial_acs"),
    land: layers.land != null ? "derived_from_acs" : "pending_acs_values",
    access: lv.access ? "live_osm" : "pending_live_feed",
    power: lv.power ? "field_verified" : "pending_field_intel",
    activity: lv.activity ? "live_census_bps" : "pending_live_feed",
  };
  // A pending ACS layer says which table it is waiting on, so the gap names its
  // own remedy instead of reading as a system fault.
  const ACS_PENDING =
    "Pending. No usable values were supplied for this layer's inputs. Missing or suppressed estimates cannot establish a score.";
  const acsSource = recordVintage(d)?.source || 'Supplied inputs with unverified Census vintage';
  // Provenance is built from the tables that ACTUALLY resolved. The sentence
  // used to name all three People tables and claim the method weighed vacancy
  // and affordability whenever any ONE of them was published, so a place with an
  // income figure and nothing else shipped a citation to two tables that
  // contributed nothing. The MCP instructions tell a model to cite this string
  // rather than present the number bare, which is exactly why it has to be true.
  function acsTables(pairs) {
    return pairs.filter((p) => p[1] != null).map((p) => p[0]);
  }
  const peopleTables = acsTables([["B19013", d.medianIncome], ["B25077", d.medianHomeValue], ["B25002", d.vacancyPct]]);
  const peopleMethod = acsTables([["median income", d.medianIncome], ["affordability", d.medianHomeValue], ["vacancy", d.vacancyPct]]);
  const moneyTables = acsTables([["B01003", d.population], ["B25077", d.medianHomeValue]]);
  const peopleFull = peopleTables.length === 3;
  const moneyFull = moneyTables.length === 2;
  const partialNote = " Layers not named here were not published for this place and contributed nothing.";
  const provenance = {
    people: layers.people != null
      ? acsSource + ", tables " + peopleTables.join(", ") + ". Heuristic method: " + peopleMethod.join(", ") + " against fixed reference points; not measured demand." + (peopleFull ? "" : partialNote)
      : ACS_PENDING,
    money: layers.money != null
      ? "Derived from " + acsSource + ", tables " + moneyTables.join(", ") + ". Heuristic method: population scale plus home value. Not an incentive database read or evidence of available capital." + (moneyFull ? "" : partialNote)
      : ACS_PENDING,
    land: layers.land != null
      ? "Derived from " + acsSource + " housing vacancy (B25002). Heuristic proxy only; housing vacancy does not measure vacant land or buildable capacity."
      : ACS_PENDING,
    access: lv.access
      ? lv.access.provenance
      : "Pending. Binds to OpenStreetMap infrastructure signals (interstate junctions, transit stations, airports); no verified read for this city yet.",
    power: lv.power
      ? lv.power.provenance
      : "Pending Cividian field read for this city. Structured inputs (incentive aggressiveness, entitlement friction, political will) bind when a sourced field entry exists.",
    activity: lv.activity
      ? lv.activity.provenance
      : "Pending. Binds to the US Census Building Permits Survey; no verified permit read for this place yet.",
  };

  // Weighted total over resolved layers only, weights renormalized. A pending
  // layer contributes nothing instead of a fake constant.
  let total = 0;
  let wsum = 0;
  for (const k in WEIGHTS) {
    if (layers[k] != null) {
      total += layers[k] * WEIGHTS[k];
      wsum += WEIGHTS[k];
    }
  }
  const score = wsum >= MIN_SCORE_WEIGHT ? clamp(Math.round(total / wsum), 20, 95) : null;
  const liveKeys = Object.keys(WEIGHTS).filter((k) => layers[k] != null);
  const result = {
    score,
    verdict: verdict(score),
    layers,
    weights: WEIGHTS,
    layerStatus,
    provenance,
    dataDriven: liveKeys,
    liveWeightShare: Math.round(wsum * 100),
    minimumWeightShare: Math.round(MIN_SCORE_WEIGHT * 100),
    // When the score is withheld, say so where the score would have been, in
    // the same register the pending layers use. A null with no reason reads as
    // a fault; this one names its own remedy.
    scoreNote: score == null
      ? (wsum > 0
        ? "No Cividian Score. Only " + Math.round(wsum * 100) + " percent of the score weighting resolved for this place, below the " + Math.round(MIN_SCORE_WEIGHT * 100) + " percent floor, so a composite would be a conclusion about layers that were never read. The layers that did resolve are reported above."
        : "No Cividian Score. The Census matched this place but published no values for it, so nothing was read to score.")
      : null,
  };
  result.decision = createCityDecision(result, d, lv);
  return result;
}

// A null score has no verdict. Returning PASS for "nothing was readable" would
// state a conclusion about a place Cividian never managed to read, which is the
// most damaging thing this file could get wrong. lib/brief.js and api/briefs.js
// already guarded their own calls against exactly this; the guard belongs here
// so every caller inherits it.
export function verdict(score) {
  if (score == null || !Number.isFinite(score) || score < 0 || score > 100) return null;
  if (score >= 70)
    return { tag: "PURSUE", note: "Higher heuristic band; verify property-specific evidence before making a decision." };
  if (score >= 55)
    return { tag: "WATCH", note: "Middle heuristic band; unresolved evidence requires human review." };
  return { tag: "PASS", note: "Lower heuristic band; this is not a recommendation to reject a property." };
}

// ---------------------------------------------------------------------------
// The UK score lives in lib/scoring-uk.js and is re-exported here so a caller
// who looks in the house scoring module finds it.
//
// It is a separate module rather than more branches in computeScore above, for
// the same reason UK_PROVIDERS is a separate registry: the two indices share
// the renormalization RULE and nothing else. The US weights describe a city a
// developer might enter. The UK weights describe a street a restorer might
// assemble, and half their inputs carry the opposite sign, most obviously
// fragmentation, which is scored as an opportunity there and would be a defect
// here. Threading both through one function would put a UK sign convention one
// careless edit away from the US score.
// ---------------------------------------------------------------------------
export { computeUkScore, UK_WEIGHTS } from "./scoring-uk.js";
