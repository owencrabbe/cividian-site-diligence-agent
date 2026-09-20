// Versioned presentation contract for the US city model. Scoring owns the
// arithmetic and verdict; this module packages its result and source evidence.
// Consumers must display this verdict, never recreate threshold logic.
import { recordVintage } from './census.js';
export const CITY_DECISION_SCHEMA = 'city-decision.v1';
export const CITY_SCORE_MODEL_VERSION = 'cividian-city-score.us.v1';

const LAYER_INTERPRETATION = {
  people: ['Income & housing composite', 'Reference-based combination of income, owner-occupied home value and housing vacancy; not measured demand.'],
  money: ['Population & value proxy', 'Population and median home value are not evidence of grants, incentives, capital availability or investor returns.'],
  land: ['Housing vacancy proxy', 'Housing vacancy is not vacant land, land availability, buildable area or parcel development capacity.'],
  access: ['Infrastructure proximity proxy', 'Mapped infrastructure counts do not establish site access rights, capacity or travel time.'],
  power: ['Institutional context proxy', 'Supplied field assessments do not establish approvals, utility capacity or entitlement certainty.'],
  activity: ['Permit activity proxy', 'Residential permit counts are not starts, completions, leasing demand or investment returns.'],
};
const ACS_INPUTS = {
  medianIncome: { table: 'B19013', label: 'Median household income', unit: 'USD' },
  medianHomeValue: { table: 'B25077', label: 'Median home value', unit: 'USD' },
  vacancyPct: { table: 'B25002', label: 'Housing vacancy', unit: 'percent' },
  population: { table: 'B01003', label: 'Population', unit: 'people' },
};
const LAYER_INPUTS = {
  people: ['medianIncome', 'medianHomeValue', 'vacancyPct'],
  money: ['population', 'medianHomeValue'],
  land: ['vacancyPct'],
};
const PROVIDER_INPUTS = {
  access: { source: 'OpenStreetMap via Overpass API', sourceUrl: 'https://www.openstreetmap.org/copyright', fields: [['junctions', 'Motorway junctions within 15 km'], ['stations', 'Transit stations within 10 km'], ['airports', 'IATA airports within 40 km']] },
  activity: { source: 'US Census Building Permits Survey', sourceUrl: 'https://www.census.gov/construction/bps/', fields: [['units', 'Residential units permitted'], ['unitsPrior', 'Residential units permitted in prior year']] },
  power: { source: 'Cividian field intelligence', sourceUrl: null, fields: [] },
};

function acsEvidence(key, base) {
  const vintage = recordVintage(base);
  const input = ACS_INPUTS[key];
  const value = base[key] ?? null;
  return {
    id: (vintage ? 'acs-' + vintage.year : 'unattributed') + '-' + key,
    label: input.label,
    value,
    unit: input.unit,
    status: value == null ? 'missing' : 'resolved',
    kind: vintage ? (key === 'vacancyPct' ? 'derived_measurement' : 'source_measurement') : 'unattributed_input',
    source: vintage?.source || 'Source vintage unverified',
    sourceUrl: vintage ? vintage.apiBase + '/groups/' + input.table + '.html' : null,
    asOf: vintage?.asOf || null,
  };
}

function providerEvidence(key, live) {
  const record = live[key];
  const provider = PROVIDER_INPUTS[key];
  if (!record) return [];
  const signals = record.signals || {};
  const asOf = key === 'access' ? (signals.fetchedAt || null) :
    key === 'activity' && signals.year != null ? String(signals.year) : null;
  const measurements = provider.fields.map(([field, label]) => {
    const value = Number.isFinite(signals[field]) ? signals[field] : null;
    return {
      id: key + '-' + field,
      label,
      value,
      unit: 'count',
      status: value == null ? 'missing' : 'resolved',
      kind: 'source_measurement',
      source: provider.source,
      sourceUrl: provider.sourceUrl,
      asOf: field === 'unitsPrior' ? (signals.priorYear == null ? null : String(signals.priorYear)) : asOf,
    };
  });
  // The field scorer supplies a sourced derived reading, not raw measurements.
  // Cached scored records can likewise lack raw signals. Keep that distinction
  // explicit instead of inventing measurements or parsing dates from prose.
  if (!measurements.some((item) => item.status === 'resolved')) {
    measurements.push({
      id: key + '-derived-score', label: 'Provider-derived layer score',
      value: record.score, unit: 'score_out_of_100', status: 'resolved',
      kind: 'derived_score', source: provider.source, sourceUrl: provider.sourceUrl,
      asOf,
    });
  }
  return measurements;
}

// `scoring` is the completed result from computeScore, including its verdict.
// There is deliberately no score-to-verdict arithmetic in this serializer.
export function createCityDecision(scoring, base, live = {}) {
  const layers = {};
  const pendingLayers = [];
  const partialLayers = [];
  for (const key of Object.keys(scoring.weights)) {
    const score = scoring.layers[key];
    if (score == null) pendingLayers.push(key);
    if (scoring.layerStatus[key] === 'partial_acs') partialLayers.push(key);
    layers[key] = {
      displayName: LAYER_INTERPRETATION[key][0],
      interpretation: { kind: 'heuristic_proxy', limitation: LAYER_INTERPRETATION[key][1] },
      score,
      weight: scoring.weights[key],
      weightPct: Math.round(scoring.weights[key] * 100),
      status: scoring.layerStatus[key],
      provenance: scoring.provenance[key],
      evidence: LAYER_INPUTS[key]
        ? LAYER_INPUTS[key].map((input) => acsEvidence(input, base))
        : providerEvidence(key, live),
    };
  }
  return {
    schema: CITY_DECISION_SCHEMA,
    modelVersion: CITY_SCORE_MODEL_VERSION,
    geography: {
      country: 'US', scope: base.scope === 'state' ? 'state' : 'city',
      name: base.name || null, state: base.state || null,
      stateFips: base.stateFips || null, placeFips: base.placeFips || null,
    },
    score: scoring.score,
    verdict: scoring.verdict,
    scoreNote: scoring.scoreNote,
    interpretation: {
      kind: 'unvalidated_heuristic',
      band: ({ PURSUE: 'higher', WATCH: 'middle', PASS: 'lower' })[scoring.verdict?.tag] || null,
      bandLabel: ({ PURSUE: 'Higher heuristic band', WATCH: 'Middle heuristic band', PASS: 'Lower heuristic band' })[scoring.verdict?.tag] || 'Score pending',
      note: 'A citywide screening heuristic using selected inputs and fixed reference points. Predictive validity has not been established. It does not decide whether to invest, identify a viable property or replace human review.',
      legacyVerdict: 'PURSUE/WATCH/PASS are compatibility codes for historical clients, not investment recommendations. Human decisions are recorded separately.',
    },
    coverage: {
      status: scoring.score != null ? 'sufficient' : scoring.liveWeightShare > 0 ? 'insufficient' : 'unavailable',
      resolvedWeightPct: scoring.liveWeightShare,
      minimumWeightPct: scoring.minimumWeightShare,
      resolvedLayerCount: Object.keys(layers).length - pendingLayers.length,
      totalLayerCount: Object.keys(layers).length,
      pendingLayers,
      partialLayers,
      note: 'Coverage is the share of model weighting with a resolved layer, including partial ACS layers. It is not a confidence, accuracy, or freshness measure. Pending inputs are excluded; resolved weights are renormalized.',
    },
    layers,
    source: base.source || 'Source vintage unverified',
    asOf: base.asOf || null,
    census: base.census || null,
    computedAt: new Date().toISOString(),
  };
}
