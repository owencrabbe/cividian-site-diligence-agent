import { getRedis } from './redis.js';

export const MARKETING_EVENTS = Object.freeze([
  'marketing_page_view', 'explore_site_click', 'site_search_started',
  'site_investigation_completed', 'walkthrough_form_started',
  'walkthrough_requested', 'qualified_conversation',
]);
export const CLIENT_MARKETING_EVENTS = Object.freeze([
  'marketing_page_view', 'explore_site_click', 'walkthrough_form_started',
]);
export const MARKETING_KEY = 'pago:marketing:events:v1';
const SOURCES = new Set(['linkedin', 'instagram', 'facebook', 'youtube', 'google', 'outreach']);
const MEDIUMS = new Set(['organic_social', 'paid_social', 'paid_search', 'email']);
const CONTENT = new Set([
  'linkedin_founder_intro', 'linkedin_site_demo', 'linkedin_unknowns', 'company_website',
  'li01_question', 'li02_evidence_gap', 'li03_product_walkthrough',
  'instagram_site_demo', 'facebook_site_demo', 'page_cta', 'bio_link',
  'm01_first_read', 'm02_evidence_unknown', 'm03_assumptions', 'm04_missing_evidence',
  'a01_evidence', 'a02_next_step', 'a03_assumptions',
  'youtube_site_demo', 'youtube_unknowns', 'v01_walkthrough', 'v02_first_read',
  'v03_missing_evidence', 'v04_assumptions',
  'outreach_pilot_invite', 'google_site_diligence',
]);
const ROUTES = new Set(['/for-developers', '/diligence', '/']);
const PLACEMENTS = new Set(['hero', 'nav', 'body', 'footer', 'process', 'limits', 'walkthrough', 'closing', 'landing_form', 'unknown']);

function token(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

export function sanitizeMarketingAttribution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = token(input.utm_source, SOURCES);
  const medium = token(input.utm_medium, MEDIUMS);
  const campaign = input.utm_campaign === 'site_diligence_pilot_2026q4' ? input.utm_campaign : null;
  // Only registered creative slugs can reach analytics. This prevents an
  // arbitrary campaign parameter from carrying a person's or site's details.
  const content = token(input.utm_content, CONTENT);
  return {
    ...(source ? { utm_source: source } : {}),
    ...(medium ? { utm_medium: medium } : {}),
    ...(campaign ? { utm_campaign: campaign } : {}),
    ...(content ? { utm_content: content } : {}),
  };
}

// The landing page writes only allowlisted campaign tokens to this short-lived
// first-party cookie. The product may count a completed brief without storing
// or exporting its address, query, or contents in marketing analytics.
export function marketingAttributionFromRequest(req) {
  const header = String(req?.headers?.cookie || '');
  const match = header.split(';').map(part => part.trim()).find(part => part.startsWith('cividian_marketing_touch='));
  if (!match || match.length > 600) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(match.slice('cividian_marketing_touch='.length)));
    const touch = sanitizeMarketingAttribution(parsed);
    return touch.utm_campaign === 'site_diligence_pilot_2026q4' && touch.utm_source ? touch : null;
  } catch { return null; }
}

export function sanitizeMarketingEvent(event, input = {}, { client = false } = {}) {
  if (!(client ? CLIENT_MARKETING_EVENTS : MARKETING_EVENTS).includes(event)) return null;
  const attribution = sanitizeMarketingAttribution(input);
  return {
    event,
    route: token(input.route, ROUTES) || '/for-developers',
    ...(event === 'explore_site_click' || event === 'walkthrough_form_started'
      ? { placement: token(input.placement, PLACEMENTS) || 'unknown' } : {}),
    ...attribution,
  };
}

// This is a bounded first-party measurement log. Its records have no URL,
// session ID, IP, user agent, contact detail, or property text. A failed write
// is visible to callers so they do not mistake an unrecorded event for proof.
export async function recordMarketingEvent(event, input = {}, options = {}) {
  const record = sanitizeMarketingEvent(event, input, options);
  if (!record) return false;
  const redis = await getRedis();
  if (!redis) return false;
  try {
    const row = { ...record, at: new Date().toISOString() };
    const transaction = redis.multi();
    transaction.rPush(MARKETING_KEY, JSON.stringify(row));
    transaction.lTrim(MARKETING_KEY, -20000, -1);
    transaction.expire(MARKETING_KEY, 90 * 24 * 3600);
    await transaction.exec();
    return true;
  } catch {
    return false;
  }
}

export const recordConfirmedMarketingEvent = (event, input = {}) => {
  if (!['site_search_started', 'site_investigation_completed', 'walkthrough_requested', 'qualified_conversation'].includes(event)) return Promise.resolve(false);
  return recordMarketingEvent(event, input);
};
