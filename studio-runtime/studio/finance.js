/** Deterministic screening arithmetic. Nothing here supplies market inputs,
 * verifies a budget, draws a construction loan, or infers a fitted floor plan. */
import { parseIdentifier } from './contracts.js';
import { M2_PER_SQFT, StudioError } from './geometry.js';
export const COST_CATEGORIES = ['acquisition', 'closing', 'demolition_remediation', 'site_utilities', 'hard_construction', 'soft_costs', 'permits_fees', 'contingency', 'financing', 'carrying', 'reserves'];
const MAX_CENTS = 100_000_000_000_000;
function invalid(message) { throw new StudioError('invalid_finance', message); }
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid(`${label} must be an object.`);
    return value;
}
function integer(value, label, max = MAX_CENTS) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
        invalid(`${label} must be a nonnegative bounded integer. Currency amounts are cents, not dollars.`);
    return value;
}
function note(value, label, required = false) {
    if (typeof value !== 'string' || value.length > 600 || /[\u0000-\u0008\u000b-\u001f]/.test(value) || required && !value.trim())
        invalid(`${label} must be plain text of at most 600 characters${required ? ' and cannot be blank' : ''}.`);
    return value.trim();
}
export function parseFinance(input) {
    const d = object(input, 'Financial assumptions');
    if (d['schema'] !== 'studio.finance.v1' || d['currency'] !== 'USD')
        invalid('Use the USD studio.finance.v1 schema. No exchange rate is inferred.');
    if (d['basis'] !== 'user_assumption' && d['basis'] !== 'synthetic_example')
        invalid('Financial inputs cannot claim verified or lender-approved status.');
    if (!Array.isArray(d['costs']) || d['costs'].length !== COST_CATEGORIES.length)
        invalid('Every cost category must appear exactly once, even when unknown or explicitly excluded. Do not combine overlapping cost scopes.');
    const seen = new Set();
    const entries = d['costs'].map((value) => {
        const c = object(value, 'Cost line'), category = c['category'];
        if (!COST_CATEGORIES.includes(category) || seen.has(category))
            invalid('Cost categories must be recognized and unique. A category cannot be counted twice.');
        seen.add(category);
        if (c['method'] === 'unknown')
            return { category, method: 'unknown' };
        if (c['method'] === 'excluded')
            return { category, method: 'excluded', reason: note(c['reason'], 'Exclusion reason', true) };
        if (c['method'] === 'amount')
            return { category, method: 'amount', cents: c['cents'] === null ? null : integer(c['cents'], 'Cost amount') };
        if (c['method'] === 'gross_area_rate' && category === 'hard_construction')
            return { category, method: 'gross_area_rate', centsPerSqft: c['centsPerSqft'] === null ? null : integer(c['centsPerSqft'], 'Gross-area cost rate', 10_000_000) };
        return invalid('Only hard construction supports a gross-square-foot rate. Enter other categories as explicit amounts or exclusions.');
    });
    const i = object(d['income'], 'Income assumptions');
    const optional = (key, max = MAX_CENTS) => i[key] === null ? null : integer(i[key], key, max);
    return {
        schema: 'studio.finance.v1', id: parseIdentifier(d['id'], 'Finance assumption ID'), currency: 'USD', basis: d['basis'], sourceNote: note(d['sourceNote'], 'Source note'),
        costs: COST_CATEGORIES.map(category => entries.find(e => e.category === category)),
        income: {
            unitCount: i['unitCount'] === 'geometry_capacity' ? 'geometry_capacity' : integer(i['unitCount'], 'Assumed unit count', 100_000),
            residentialMonthlyRentCents: optional('residentialMonthlyRentCents'),
            retailAnnualRentPerNetSqftCents: optional('retailAnnualRentPerNetSqftCents'),
            officeAnnualRentPerNetSqftCents: optional('officeAnnualRentPerNetSqftCents'),
            otherAnnualIncomeCents: optional('otherAnnualIncomeCents'), vacancyBps: optional('vacancyBps', 10_000),
            operatingExpensesAnnualCents: optional('operatingExpensesAnnualCents'), debtServiceAnnualCents: optional('debtServiceAnnualCents'),
        },
    };
}
export function blankFinance(id) {
    return parseFinance({ schema: 'studio.finance.v1', id, currency: 'USD', basis: 'user_assumption', sourceNote: '', costs: COST_CATEGORIES.map(category => ({ category, method: 'unknown' })),
        income: { unitCount: 'geometry_capacity', residentialMonthlyRentCents: null, retailAnnualRentPerNetSqftCents: null, officeAnnualRentPerNetSqftCents: null, otherAnnualIncomeCents: null, vacancyBps: null, operatingExpensesAnnualCents: null, debtServiceAnnualCents: null } });
}
function rounded(value) {
    const cents = Math.round(value);
    if (!Number.isFinite(value) || !Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS)
        invalid('The calculated amount exceeds the supported screening budget. No overflowing result was returned.');
    return cents;
}
export function dollarsToCents(value) {
    const s = value.trim();
    if (!s)
        return null;
    if (!/^\d+(?:\.\d{1,2})?$/.test(s))
        invalid('Enter a nonnegative dollar amount with at most two decimal places, without currency symbols.');
    const parts = s.split('.');
    const cents = Number(parts[0]) * 100 + Number((parts[1] ?? '').padEnd(2, '0'));
    return integer(cents, 'Amount');
}
export function calculateFinance(s, q) {
    if (q.scenarioId !== s.scenarioId || q.scenarioVersionId !== s.versionId || q.assumptionVersionId !== s.assumptions.id)
        throw new StudioError('stale_calculation', 'Geometry, physical assumptions and scenario version must match before calculating economics.', 409);
    const f = s.finance ? parseFinance(s.finance) : null;
    const missingCostCategories = [], exclusions = [];
    let known = 0;
    const costLines = (f?.costs ?? COST_CATEGORIES.map(category => ({ category, method: 'unknown' }))).map(c => {
        let cents = null, formula = 'Unknown, not zero';
        if (c.method === 'unknown')
            missingCostCategories.push(c.category);
        else if (c.method === 'excluded') {
            cents = 0;
            formula = `Explicit exclusion: ${c.reason}`;
            exclusions.push({ category: c.category, reason: c.reason });
        }
        else if (c.method === 'amount') {
            cents = c.cents;
            formula = cents === null ? 'Unknown amount, not zero' : 'Explicit line-item assumption';
            if (cents === null)
                missingCostCategories.push(c.category);
        }
        else {
            cents = c.centsPerSqft === null ? null : rounded(q.proposedGrossAreaM2 / M2_PER_SQFT * c.centsPerSqft);
            formula = 'Actual proposed gross m² / 0.09290304 × cents per gross ft²; rounded per line';
            if (cents === null)
                missingCostCategories.push(c.category);
        }
        known = rounded(known + (cents ?? 0));
        return { category: c.category, cents, formula };
    });
    const total = missingCostCategories.length ? null : known;
    const i = f?.income, missing = [];
    const units = i?.unitCount === undefined || i.unitCount === 'geometry_capacity' ? q.estimatedUnits : i.unitCount;
    const commercial = { retail: q.areaByUseM2.retail * s.assumptions.efficiency / M2_PER_SQFT, office: q.areaByUseM2.office * s.assumptions.efficiency / M2_PER_SQFT };
    let potential = null, effective = null, noi = null;
    if (!i)
        missing.push('Financial assumptions');
    else {
        if (units > 0 && i.residentialMonthlyRentCents === null)
            missing.push('Monthly residential rent');
        if (commercial.retail > 0 && i.retailAnnualRentPerNetSqftCents === null)
            missing.push('Annual retail rent per net ft²');
        if (commercial.office > 0 && i.officeAnnualRentPerNetSqftCents === null)
            missing.push('Annual office rent per net ft²');
        if (i.otherAnnualIncomeCents === null)
            missing.push('Other annual income, including explicit zero');
        if (!missing.length)
            potential = rounded(rounded(units * (i.residentialMonthlyRentCents ?? 0) * 12) + rounded(commercial.retail * (i.retailAnnualRentPerNetSqftCents ?? 0)) + rounded(commercial.office * (i.officeAnnualRentPerNetSqftCents ?? 0)) + (i.otherAnnualIncomeCents ?? 0));
        if (i.vacancyBps === null)
            missing.push('Vacancy / collection loss');
        else if (potential !== null)
            effective = Number((BigInt(potential) * BigInt(10_000 - i.vacancyBps) + 5000n) / 10000n);
        if (i.operatingExpensesAnnualCents === null)
            missing.push('Annual operating expenses');
        else if (effective !== null)
            noi = rounded(effective - i.operatingExpensesAnnualCents);
    }
    return {
        formulaVersion: 'studio.screening.v1', projectId: s.site.projectId, siteId: s.site.id, scenarioId: s.scenarioId, scenarioVersionId: s.versionId,
        physicalAssumptionId: s.assumptions.id, financeAssumptionId: f?.id ?? null, currency: 'USD', basis: f?.basis ?? 'unavailable',
        knownCostSubtotalCents: known, totalDevelopmentCostCents: total, missingCostCategories, exclusions, costLines, unitCount: units, commercialNetSqft: commercial,
        potentialGrossIncomeCents: potential, effectiveGrossIncomeCents: effective, noiCents: noi,
        yieldOnCost: noi !== null && total !== null && total > 0 ? noi / total : null,
        dscr: noi !== null && i?.debtServiceAnnualCents != null && i.debtServiceAnnualCents > 0 ? noi / i.debtServiceAnnualCents : null,
        missingIncomeInputs: missing,
        notes: ['Screening assumptions, not verified market data, an appraisal, or financing approval.', 'Revenue uses modeled capacity or an explicitly assumed unit count, not fitted units. Commercial net area uses the declared efficiency.', 'Vacancy / collection loss applies uniformly to all potential income. Operating expenses exclude debt service. Financing and carrying costs are explicit allowances, not a draw schedule.', 'Cost categories must be non-overlapping. Do not put a combined contractor total in hard construction and repeat included scope in other lines.', ...(f?.sourceNote ? [`User source note: ${f.sourceNote}`] : []), ...(exclusions.length ? ['Total covers the declared scope only. Explicit exclusions remain listed and are not evidence that a cost cannot occur.'] : [])],
    };
}
