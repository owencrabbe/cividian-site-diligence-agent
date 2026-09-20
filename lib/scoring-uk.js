// lib/scoring-uk.js
// The UK layer set and the UK score. Separate from lib/scoring.js on purpose:
// the two share the renormalization RULE and nothing else. The US weights
// (People 25, Money 22, Land 18, Access 15, Power 12, Activity 8) describe a
// city a developer might enter. These describe a street a restorer might
// assemble, which is a different question with a different sign on half its
// inputs.
//
// lib/scoring.js re-exports computeUkScore so a caller who looks in the house
// scoring module finds it, without any UK input ever reaching the US formula.
//
// The renormalization rule is inherited exactly. An unresolved layer is
// EXCLUDED and the remaining weights rescale. It is never defaulted to 50 or to
// any other invented midpoint. layerStatus says why a layer is pending and
// liveWeightShare reports how much of the score is live.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Weights are a starting point, not doctrine. They are published here rather
// than hidden so the arithmetic is auditable, but the FORMULA below stays
// server-side and the client only ever receives numbers and provenance.
export const UK_WEIGHTS = {
  heritage_density: 0.15,
  deterioration: 0.15,
  fragmentation: 0.20,
  absentee_exposure: 0.10,
  residential_headroom: 0.15,
  public_capital: 0.10,
  demand: 0.15,
};

// Same floor and same reasoning as the US side: renormalizing over resolved
// layers is honest arithmetic, but it says nothing about whether enough was
// resolved to warrant a single number. Two layers clears it; any one layer does
// not, so a score can never become a restatement of one reading.
const MIN_SCORE_WEIGHT = 0.40;

// ---------------------------------------------------------------------------
// Layer scorers. Each returns { score, provenance, signals } or null.
// null means the inputs did not resolve. It never means zero.
// ---------------------------------------------------------------------------

// Listed entries and conservation area coverage per hectare. Dense heritage is
// the raw material of a restoration scheme, so more is a higher score.
export function heritageDensity(o) {
  const listed = o && Number(o.listedEntries);
  const hectares = o && Number(o.hectares);
  if (!Number.isFinite(listed) || !Number.isFinite(hectares) || hectares <= 0) return null;
  const perHa = listed / hectares;
  const inCa = o.inConservationArea === true;
  const s = clamp(Math.round(20 + clamp(perHa * 9, 0, 55) + (inCa ? 20 : 0)), 0, 100);
  return {
    score: s,
    provenance: 'Historic England, National Heritage List for England, read live. Method: ' + listed
      + ' listed entries over ' + (Math.round(hectares * 100) / 100) + ' hectares, '
      + (Math.round(perHa * 10) / 10) + ' per hectare'
      + (inCa ? ', within a conservation area published by the local planning authority.' : ', not within a published conservation area.')
      + ' Entries, not buildings: one entry can span a terrace.',
    signals: { listedEntries: listed, perHectare: Math.round(perHa * 10) / 10, inConservationArea: inCa },
  };
}

// Heritage at Risk entries, plus the absence of a recent energy certificate as
// a weak proxy for a building that has not been let or sold. Both point at
// buildings that need work, which in this product is the opportunity.
export function deterioration(o) {
  const atRisk = o && Number(o.atRiskCount);
  const total = o && Number(o.propertyCount);
  if (!Number.isFinite(atRisk) || !Number.isFinite(total) || total <= 0) return null;
  const staleShare = Number.isFinite(Number(o.staleEpcShare)) ? Number(o.staleEpcShare) : null;
  let s = 25 + clamp((atRisk / total) * 220, 0, 45);
  if (staleShare != null) s += clamp(staleShare * 30, 0, 30);
  return {
    score: clamp(Math.round(s), 0, 100),
    provenance: 'Historic England Heritage at Risk register via the MHCLG Planning Data Platform'
      + (staleShare != null ? ', with energy certificate recency from the Get energy performance of buildings data service' : '')
      + '. Method: ' + atRisk + ' at-risk entries across ' + total + ' properties'
      + (staleShare != null ? (', and ' + Math.round(staleShare * 100) + ' percent with no certificate lodged in five years') : ', certificate recency not read')
      + '. A high score here means buildings that need work, which is what this product is looking for.',
    signals: { atRiskCount: atRisk, propertyCount: total, staleEpcShare: staleShare },
  };
}

// FRAGMENTATION IS SCORED POSITIVELY. A block held by thirty owners with no
// majority holder is the assembly target; a block already in one pair of hands
// has nothing to assemble. This is the inverse of almost every other property
// score and the comment in lib/block-uk.js says the same thing for the same
// reason. Do not "fix" the sign.
export function fragmentation(o) {
  const hhi = o && Number(o.hhi);
  if (!Number.isFinite(hhi) || hhi <= 0) return null;
  const titlesPerHa = Number.isFinite(Number(o.titlesPerHectare)) ? Number(o.titlesPerHectare) : null;
  // hhi runs 0 to 1; 1 is one owner. Invert it.
  let s = 10 + clamp((1 - hhi) * 80, 0, 80);
  if (titlesPerHa != null) s += clamp(titlesPerHa * 0.4, 0, 10);
  return {
    score: clamp(Math.round(s), 0, 100),
    provenance: 'Derived from the block ownership roll. Method: Herfindahl index of '
      + (Math.round(hhi * 1000) / 1000) + ' over ' + (o.distinctOwners != null ? o.distinctOwners : 'an unrecorded number of') + ' distinct owners'
      + (titlesPerHa != null ? (', ' + (Math.round(titlesPerHa * 10) / 10) + ' titles per hectare') : '')
      + '. Inverted deliberately: a fragmented block is the opportunity in this product, not the risk.',
    signals: { hhi: hhi, distinctOwners: o.distinctOwners != null ? o.distinctOwners : null, titlesPerHectare: titlesPerHa },
  };
}

// Overseas and distant-registered-office share by floor area. High exposure
// means owners who are unlikely to invest and may be easier to buy out, so it
// scores positively, but the provenance says that is an inference about
// likelihood and not about any individual owner.
export function absenteeExposure(o) {
  const share = o && Number(o.absenteeShare);
  if (!Number.isFinite(share)) return null;
  const overseas = Number.isFinite(Number(o.overseasShare)) ? Number(o.overseasShare) : 0;
  const s = clamp(Math.round(20 + share * 55 + overseas * 25), 0, 100);
  return {
    score: s,
    provenance: 'Derived from HM Land Registry corporate ownership and the Companies House register. Method: '
      + Math.round(share * 100) + ' percent of assessable corporate-owned floor area carries at least one absentee condition, of which '
      + Math.round(overseas * 100) + ' percent is overseas-registered. '
      + 'This is an inference about how likely an owner is to reinvest, derived from where a company is administered. It is not a statement about any owner.',
    signals: { absenteeShare: share, overseasShare: overseas, assessable: o.assessable != null ? o.assessable : null },
  };
}

// Convertible upper-floor area against what a home is worth locally. This is
// where a restoration scheme finds its residual value.
export function residentialHeadroom(o) {
  const units = o && Number(o.likelyUnits);
  const price = o && Number(o.ladMedianPrice);
  if (!Number.isFinite(units) || !Number.isFinite(price) || price <= 0) return null;
  const rent = Number.isFinite(Number(o.ladMedianRent)) ? Number(o.ladMedianRent) : null;
  // Yield on the local rent, where it is known, is a better signal than the
  // capital value alone: a cheap town with cheap rents has no headroom.
  const grossYield = rent != null ? (rent * 12) / price : null;
  let s = 20 + clamp(units * 1.6, 0, 40);
  if (grossYield != null) s += clamp((grossYield - 0.05) * 900, -15, 30);
  return {
    score: clamp(Math.round(s), 0, 100),
    provenance: 'Derived from energy certificate floor areas against the UK House Price Index and the ONS price index of private rents, both at local authority district level. Method: '
      + units + ' estimated convertible upper-floor units against a local median price of ' + Math.round(price).toLocaleString('en-GB')
      + (rent != null ? (' and a median monthly rent of ' + Math.round(rent).toLocaleString('en-GB') + ', a gross yield of ' + (Math.round(grossYield * 1000) / 10) + ' percent') : ', rent not read')
      + '. The unit estimate is arithmetic over floor area and footprint, not a planning judgment.',
    signals: { likelyUnits: units, ladMedianPrice: price, ladMedianRent: rent, grossYield: grossYield != null ? Math.round(grossYield * 1000) / 1000 : null },
  };
}

// Whether public money has already been pointed at this place. A closed
// programme still counts: it means the delivery relationships exist and the
// evidence base was written.
export function publicCapital(o) {
  const programmes = o && Array.isArray(o.programmes) ? o.programmes : null;
  if (!programmes) return null;
  const active = programmes.filter(function (p) { return p.status && /open|active|live/i.test(p.status); }).length;
  const closed = programmes.length - active;
  const s = clamp(Math.round(25 + active * 25 + closed * 12), 0, 100);
  return {
    score: s,
    provenance: 'Historic England funding areas, read live. Method: ' + programmes.length + ' heritage funding programme(s) have covered this point ('
      + active + ' active, ' + closed + ' closed). '
      + 'A closed programme still counts: the delivery relationships and the evidence base survive it. '
      + 'This covers the two programmes published as geography only. The Levelling Up Fund, Towns Fund, Pride in Place and the High Streets Strategy are not published as geography and are not in this layer.',
    signals: { programmes: programmes.map(function (p) { return p.name + ' (' + p.programme + ')'; }), active: active, closed: closed },
  };
}

// Local demand. Deliberately NOT scored from deprivation: a deprived town is
// where this product is most useful, and scoring deprivation down would rank
// the whole market backwards.
export function demand(o) {
  const price = o && Number(o.ladMedianPrice);
  const regional = o && Number(o.regionalMedianPrice);
  if (!Number.isFinite(price) || !Number.isFinite(regional) || regional <= 0) return null;
  const gap = price / regional;
  const trend = Number.isFinite(Number(o.priceTrend12m)) ? Number(o.priceTrend12m) : null;
  // A local price well below its region is a value gap, which is upside for a
  // restoration play rather than weakness.
  let s = 30 + clamp((1 - gap) * 90, -20, 40);
  if (trend != null) s += clamp(trend * 250, -15, 25);
  return {
    score: clamp(Math.round(s), 0, 100),
    provenance: 'UK House Price Index, published monthly by the Office for National Statistics and HM Land Registry, at local authority district level. Method: local median '
      + Math.round(price).toLocaleString('en-GB') + ' against a regional median of ' + Math.round(regional).toLocaleString('en-GB')
      + ', a ratio of ' + (Math.round(gap * 100) / 100)
      + (trend != null ? (', with a twelve month change of ' + (trend >= 0 ? '+' : '') + Math.round(trend * 1000) / 10 + ' percent') : ', trend not read')
      + '. A local price below its region is read as a value gap, which is upside for a restoration scheme.',
    signals: { ladMedianPrice: price, regionalMedianPrice: regional, ratio: Math.round(gap * 100) / 100, priceTrend12m: trend },
  };
}

// Why a layer is pending, in the layer's own terms. A pending state that names
// its own remedy reads as a gap; one that does not reads as a fault.
const PENDING = {
  heritage_density: 'Pending. Binds when the National Heritage List answers for this block and the block area is known.',
  deterioration: 'Pending. Binds when the Heritage at Risk register answers and the block has a property count.',
  fragmentation: 'Pending. Binds when an ownership roll exists. That needs HM Land Registry CCOD and OCOD, which require an account and a signed licence per dataset.',
  absentee_exposure: 'Pending. Binds when corporate owners are resolved through Companies House. Set CH_API_KEY, and load the ownership roll first.',
  residential_headroom: 'Pending. Binds when energy certificate floor areas resolve and a local house price is read. Set EPC_API_KEY.',
  public_capital: 'Pending. Binds when Historic England funding areas answer for this point.',
  demand: 'Pending. Binds when the UK House Price Index is read for this local authority district and its region.',
};

// inputs is a plain object of already-resolved readings. Anything absent gives
// a null layer, which is excluded and renormalized, never defaulted.
export function computeUkScore(inputs) {
  const i = inputs || {};
  const resolved = {
    heritage_density: safe(heritageDensity, i.heritage),
    deterioration: safe(deterioration, i.deterioration),
    fragmentation: safe(fragmentation, i.fragmentation),
    absentee_exposure: safe(absenteeExposure, i.absentee),
    residential_headroom: safe(residentialHeadroom, i.headroom),
    public_capital: safe(publicCapital, i.publicCapital),
    demand: safe(demand, i.demand),
  };

  const layers = {};
  const layerStatus = {};
  const provenance = {};
  const signals = {};
  Object.keys(UK_WEIGHTS).forEach(function (k) {
    const r = resolved[k];
    layers[k] = r ? r.score : null;
    layerStatus[k] = r ? 'live' : 'pending';
    provenance[k] = r ? r.provenance : PENDING[k];
    signals[k] = r ? r.signals : null;
  });

  let total = 0, wsum = 0;
  Object.keys(UK_WEIGHTS).forEach(function (k) {
    if (layers[k] != null) { total += layers[k] * UK_WEIGHTS[k]; wsum += UK_WEIGHTS[k]; }
  });
  const score = wsum >= MIN_SCORE_WEIGHT ? clamp(Math.round(total / wsum), 20, 95) : null;

  return {
    score: score,
    region: 'uk',
    layers: layers,
    weights: UK_WEIGHTS,
    layerStatus: layerStatus,
    provenance: provenance,
    signals: signals,
    dataDriven: Object.keys(UK_WEIGHTS).filter(function (k) { return layers[k] != null; }),
    liveWeightShare: Math.round(wsum * 100),
    scoreNote: score == null
      ? (wsum > 0
        ? 'No Cividian UK score. Only ' + Math.round(wsum * 100) + ' percent of the score weighting resolved for this block, below the '
          + Math.round(MIN_SCORE_WEIGHT * 100) + ' percent floor, so a composite would be a conclusion about layers that were never read. The layers that did resolve are reported above.'
        : 'No Cividian UK score. No layer resolved for this block, so nothing was read to score.')
      : null,
    // Stated on every response, because a reader who does not know this will
    // read the fragmentation layer exactly backwards.
    readingNote: 'Fragmentation and absentee exposure are scored POSITIVELY in this index. '
      + 'A block held by many owners, several of them distant, is the assembly opportunity this product exists to find. '
      + 'That is the inverse of a conventional property score and it is deliberate.',
  };
}

function safe(fn, arg) {
  if (!arg) return null;
  try { return fn(arg); } catch (e) { return null; }
}
