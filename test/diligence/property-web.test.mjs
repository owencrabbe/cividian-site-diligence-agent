// test/diligence/property-web.test.mjs
// The property web reader: address matching, verbatim verification, the
// "nearby homes" trap, value parsing, scenario sizing, and the no-key path.
// Constructed fixtures only; not recorded Tavily or Nebius responses.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { networkAttempts } from "./helpers.mjs";

before(() => {
  for (const k of ["NODE_ENV", "VERCEL", "VERCEL_ENV", "REDIS_URL", "NEBIUS_API_KEY", "TAVILY_API_KEY", "DILIGENCE_LIVE_INFERENCE"]) delete process.env[k];
});

const pw = await import("../../lib/diligence/property-web.js");
const budget = await import("../../lib/diligence/budget.js");
const scenarios = await import("../../lib/diligence/scenarios.js");
const objectives = await import("../../lib/diligence/objectives.js");

const LIVE = { DILIGENCE_TAVILY_ENABLED: "1", TAVILY_BUDGET_APPROVAL_REFERENCE: "synthetic", TAVILY_APPROVED_CREDITS: "1000", TAVILY_DAILY_CREDITS: "1000", TAVILY_APPROVAL_EXPIRES_AT: "2030-01-01T00:00:00Z", AUTH_SECRET: "x".repeat(40), NEBIUS_API_KEY: "k", TAVILY_API_KEY: "tvly-test-not-real", DILIGENCE_LIVE_INFERENCE: "1", AI_BUDGET_APPROVAL_REFERENCE: "ref", AI_APPROVED_BUDGET_USD: "5", DILIGENCE_DAILY_BUDGET_USD: "1", DILIGENCE_GUEST_INFERENCE: "1" };
const SITE = { kind: "address", query: "1 W 3rd St, Dayton, OH", city: "Dayton", state: "OH", point: { lat: 39.759, lon: -84.192 }, parcel: { status: "no_coverage" } };
const PAGE = "https://www.example-listings.com/homedetails/1-W-3rd-St-Dayton-OH-45402/123_zpid/";
const TEXT = "CONSTRUCTED FIXTURE, not a recorded page. 1 W 3rd St, Dayton, OH 45402. Listed by agent at 300 Main St, Dayton. Facts and features. Lot size: 0.25 Acres. Living area: 2,140 sqft. Year built: 1924. Bedrooms: 3. Bathrooms: 2. Last sold for $185,000 on 03/14/2021. Nearby homes. 22 E 4th St, Dayton, OH. Lot size: 0.9 Acres. Year built: 2011. $194,000 3 bd 22 E 4th St, Dayton, OH Sold.";

function scripted(output) {
  const calls = { search: 0, extract: 0, reader: 0 };
  return {
    calls,
    deps: {
      search: async () => { calls.search++; return { ok: true, credits: 1, results: [{ url: PAGE, title: "1 W 3rd St, Dayton, OH 45402 | Listing" }, { url: "https://www.example-listings.com/homedetails/9-Other-Ave/1/", title: "9 Other Ave" }] }; },
      extract: async () => { calls.extract++; return { ok: true, credits: 1, results: [{ url: PAGE, rawContent: TEXT }] }; },
      complete: async (req) => { calls.reader++; assert.match(req.system, /never report owner names/i); return { ok: true, output, usage: { inputTokens: 900, outputTokens: 200 }, requestId: "fixture" }; },
    },
  };
}

test("address parsing and page matching need the house number and a street word", () => {
  const s = pw.subjectAddress(SITE);
  assert.deepEqual([s.number, s.words], ["1", ["3RD"]]);
  assert.equal(pw.namesSubject(PAGE, s), true);
  assert.equal(pw.namesSubject("https://x.com/10-W-3rd-St", s), false, "10 is not 1");
  assert.equal(pw.subjectAddress({ kind: "point", query: "", parcel: {} }), null);
  assert.equal(pw.hostAuthority("madisoncounty.in.gov"), "county_record");
  assert.equal(pw.hostAuthority("zillow.com"), "listing_site");
});

test("values parse to labeled units and junk is refused", () => {
  assert.equal(pw.parseValue("lot_size", "0.25 Acres"), 10890);
  assert.equal(pw.parseValue("lot_size", "13,939 sq ft"), 13939);
  assert.equal(pw.parseValue("year_built", "1924"), 1924);
  assert.equal(pw.parseValue("year_built", "1492"), null);
  assert.equal(pw.parseValue("last_sale_price", "$185,000"), 185000);
  assert.equal(pw.parseValue("last_sale_price", "$1.2M"), 1200000);
  assert.equal(pw.parseValue("bedrooms", "3"), 3);
});

test("verified facts become unverified rows; fabricated, mismatched and nearby-home facts are rejected", async () => {
  budget.__test.reset();
  const s = scripted({ facts: [
    { field: "lot_size", value_text: "0.25 Acres", quote: "Lot size: 0.25 Acres", doc_id: "pdoc_1" },
    { field: "living_area", value_text: "2,140 sqft", quote: "Living area: 2,140 sqft", doc_id: "pdoc_1" },
    { field: "year_built", value_text: "1924", quote: "Year built: 1924", doc_id: "pdoc_1" },
    { field: "last_sale_price", value_text: "$185,000", quote: "Last sold for $185,000 on 03/14/2021", doc_id: "pdoc_1" },
    { field: "bedrooms", value_text: "4", quote: "Bedrooms: 4", doc_id: "pdoc_1" },
    { field: "bathrooms", value_text: "3", quote: "Bathrooms: 2", doc_id: "pdoc_1" },
    { field: "stories", value_text: "2", quote: "Year built: 2011", doc_id: "pdoc_1" },
    { field: "lot_size", value_text: "0.9 Acres", quote: "Lot size: 0.9 Acres", doc_id: "pdoc_1" },
    { field: "assessed_value", value_text: "$194,000", quote: "$194,000 3 bd 22 E 4th St, Dayton, OH", doc_id: "pdoc_1" },
    { field: "last_sale_date", value_text: "Sold", quote: "Last sold for $185,000", doc_id: "pdoc_1" },
    { field: "annual_property_tax", value_text: "$185,000", quote: "Last sold for $185,000", doc_id: "pdoc_1" },
  ] });
  const out = await pw.readPropertyWeb(SITE, { env: LIVE, ...s.deps });
  assert.equal(out.meta.status, "read", JSON.stringify(out.meta));
  assert.equal(out.meta.documents.length, 1, "the page that does not name the address is dropped");
  assert.ok(out.meta.dropped.some((d) => d.reason === "does_not_name_address"));
  const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r]));
  assert.equal(byKey.web_lot_size.value, 10890); assert.equal(byKey.web_lot_size.status, "unverified"); assert.equal(byKey.web_lot_size.extraction, "model_output");
  assert.equal(byKey.web_living_area.value, 2140); assert.equal(byKey.web_year_built.value, 1924); assert.equal(byKey.web_last_sale_price.value, 185000);
  assert.equal(byKey.web_lot_size.source.url, PAGE); assert.equal(byKey.web_lot_size.source.authority, "web_page");
  assert.match(byKey.web_lot_size.note, /confirm with the county assessor/);
  const reasons = out.meta.rejected.map((r) => r.reason);
  assert.ok(reasons.includes("quote_not_found"), "a quote that is not on the page is refused");
  assert.ok(reasons.includes("value_not_in_quote"), "a value that its quote does not state is refused");
  assert.equal(byKey.web_stories, undefined, "\"2\" is not a token of \"2011\"");
  assert.ok(reasons.includes("not_subject_property"), "the nearby home's 0.9 acres is never this address's lot");
  assert.equal(byKey.web_assessed_value, undefined, "a quote naming another address is refused");
  assert.equal(byKey.web_last_sale_date, undefined, "'Sold' is not a date");
  assert.equal(byKey.web_annual_property_tax, undefined, "a sale price is not a tax bill");
  assert.ok(reasons.includes("quote_lacks_context"));
  assert.equal(byKey.web_lot_size.value, 10890, "an agent address before the facts does not hide them on a page titled with this address");
  assert.equal(s.calls.reader, 1); assert.equal(out.meta.tavily.calls, 2);

  const ev = out.rows.concat([{ key: "parcel_lot_area", value: null, status: "unavailable" }]);
  const sc = await scenarios.computeScenarios({ objective: "residential_infill", evidence: ev, assumptions: objectives.normalizeAssumptions("residential_infill", {}).assumptions });
  const lot = sc.scenarios[0].inputs.find((i) => i.key === "lotSqft");
  assert.equal(lot.value, 10890); assert.equal(lot.basis, "source_estimate"); assert.equal(lot.evidenceId, "ev_web_lot_size");
  assert.ok(sc.scenarios[0].outputs.units > 0, "a web lot size lets the screen run outside parcel coverage");
});

test("a page titled with the address that lists other homes first still yields the facts under its own heading", () => {
  const subj = pw.subjectAddress(SITE);
  const page = "1 W 3rd St, Dayton, OH. Similar homes nearby. $150,000 22 E 4th St, Dayton, OH. Lot size: 0.9 Acres. $210,000 40 Oak Ave, Dayton, OH. Facts & features. Bedrooms: 3. Lot size: 0.25 Acres. Tax history for 1 W 3rd St.";
  assert.equal(pw.inFactsSection(page, "Lot size: 0.25 Acres", subj), true);
  assert.equal(pw.inFactsSection(page, "Lot size: 0.9 Acres", subj), false, "a card in the other-homes list is never the subject's");
  assert.equal(pw.beforeOtherHomes(page, "Lot size: 0.25 Acres"), false);
});

test("a page that blocks extraction is read from its search snippet and says so", async () => {
  budget.__test.reset();
  const snippetOnly = {
    search: async () => ({ ok: true, credits: 1, results: [{ url: PAGE, title: "1 W 3rd St, Dayton, OH 45402", content: "1 W 3rd St, Dayton, OH 45402 is a 3 bed, 2 bath, 2,140 sqft house built in 1924." }] }),
    extract: async () => ({ ok: true, credits: 1, results: [], failed: [{ url: PAGE, error: "blocked" }] }),
    complete: async () => ({ ok: true, output: { facts: [{ field: "living_area", value_text: "2,140 sqft", quote: "2,140 sqft house built in 1924", doc_id: "pdoc_1" }, { field: "year_built", value_text: "1924", quote: "built in 1924", doc_id: "pdoc_1" }] }, usage: { inputTokens: 100, outputTokens: 50 } }),
  };
  const out = await pw.readPropertyWeb(SITE, { env: LIVE, ...snippetOnly });
  assert.equal(out.meta.status, "read", JSON.stringify(out.meta.reason));
  assert.equal(out.meta.documents[0].textSource, "search_snippet");
  const row = out.rows.find((r) => r.key === "web_living_area");
  assert.equal(row.value, 2140); assert.match(row.note, /search result's excerpt/);
});

test("values match their quote as figures, with units that agree", () => {
  assert.equal(pw.valueInQuote("lot_size", "0.11 acres", "Lot: 0.11 Acre(s)"), true);
  assert.equal(pw.valueInQuote("lot_size", "4791 sqft", "Lot size: 4,791 sq ft"), true);
  assert.equal(pw.valueInQuote("lot_size", "0.11 acres", "Lot: 0.11 sqft"), false, "acres never become square feet");
  assert.equal(pw.valueInQuote("stories", "2", "Year built: 2011"), false);
  assert.equal(pw.valueInQuote("living_area", "1,176 sqft", "Total interior livable area: 1,176 sqft"), true);
  assert.equal(pw.valueInQuote("last_sale_price", "$187,500", "Sold for $187,500"), true);
  assert.equal(pw.valueInQuote("property_type", "Townhouse", "Home type: SingleFamily"), false);
});

test("without keys or an address the read stops before any paid call and says why", async () => {
  const s = scripted({ facts: [] });
  const noKey = await pw.readPropertyWeb(SITE, { env: { ...LIVE, TAVILY_API_KEY: "" }, ...s.deps });
  assert.equal(noKey.meta.reason, "no_key"); assert.equal(noKey.rows[0].status, "unavailable");
  const noAddr = await pw.readPropertyWeb({ ...SITE, kind: "point", query: "" }, { env: LIVE, ...s.deps });
  assert.equal(noAddr.meta.reason, "no_address");
  assert.equal(s.calls.search + s.calls.extract + s.calls.reader, 0);
});

test("offline: no code path reached the network", () => { assert.deepEqual(networkAttempts(), []); });
