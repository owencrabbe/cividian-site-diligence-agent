// data/field-intel.js
// Cividian field intelligence registry: the structured input behind the
// Power score layer. This is human-sourced ground truth, never scraped and
// never guessed. A city appears here ONLY after a real field read exists
// (meetings, published incentive actions, entitlement timelines).
//
// HONESTY CONTRACT: an empty registry is correct. A city with no entry gets
// an honest pending Power layer, not an invented one. Do not add an entry
// without sources and an asOf date.
//
// Entry shape, keyed by "city, state" in lowercase:
// {
//   incentiveAggressiveness: 0..100  how hard the city competes with real money
//   entitlementFriction:     0..100  higher = slower/harder approvals
//   politicalWill:           0..100  leadership alignment behind development
//   asOf:    "YYYY-MM-DD"            date of the field read
//   sources: ["..."]                 what the read is based on, human-checkable
// }

export const FIELD_INTEL = {
  // Populated by the Cividian operator after verified field reads.
  // Example shape (not a live entry):
  // "example city, indiana": {
  //   incentiveAggressiveness: 70,
  //   entitlementFriction: 40,
  //   politicalWill: 80,
  //   asOf: "2026-06-01",
  //   sources: ["Meeting with mayor's office 2026-05", "Published TIF action 2026-04"],
  // },
};

export function fieldIntelFor(name, state) {
  if (!name || !state) return null;
  const key = (String(name).trim() + ", " + String(state).trim()).toLowerCase();
  const e = FIELD_INTEL[key];
  if (!e) return null;
  // Refuse malformed entries rather than scoring garbage.
  const nums = [e.incentiveAggressiveness, e.entitlementFriction, e.politicalWill];
  if (nums.some((v) => typeof v !== "number" || v < 0 || v > 100)) return null;
  if (!e.asOf || !Array.isArray(e.sources) || !e.sources.length) return null;
  return e;
}
