# /api/diligence

Same-origin browser API for the Site Diligence Agent. Every response is JSON.
Business refusals are HTTP 200 with `ok:false`, a machine `error`, and a `note`
that names what was missing and what would resolve it. 401 is reserved for
anonymous callers, 403 for cross-origin POSTs, 405 for bad methods, 413 for
oversized bodies, 429 for rate limits, and 503 for storage or budget outages.

Session: a `pago_session` cookie from `POST /api/guest` (24 hour guest) or a
signed-in account. Guests can run everything; their saves live for the guest
session only. Live model inference for guests requires the deployment flag
`DILIGENCE_GUEST_INFERENCE=1`.

## GET /api/diligence

Capabilities and configuration as booleans and labels. Never key material.

```json
{
  "ok": true, "version": "diligence.v1",
  "objectives": [ { "id": "residential_infill", "label": "Residential infill", "description": "…" } ],
  "assumptionDefaults": { "residential_infill": [ { "id": "as_coverage", "key": "coveragePct", "label": "Lot coverage", "value": 55, "units": "%", "min": 5, "max": 100 } ] },
  "inference": {
    "mode": "live | fixture | unavailable",
    "provider": "nebius", "model": "nvidia/nemotron-3-super-120b-a12b",
    "configured": true, "live": false, "reasons": ["DILIGENCE_LIVE_INFERENCE is not 1"],
    "guestAllowed": false,
    "budget": { "dailyUsd": 5, "perRunUsd": 0.25, "spentTodayUsd": 0.0, "remainingRunsEstimate": 20, "store": "redis | memory" },
    "pricing": { "model": "…", "inputPer1M": 0.3, "outputPer1M": 0.9, "asOf": "2026-09-20", "source": "Nebius signed-in model card and price table", "verified": true }
  },
  "limits": { "queryMaxChars": 200, "packetMaxBytes": 24000, "maxOutputTokens": 3000, "providerTimeoutMs": 20000 },
  "session": { "kind": "guest | account | none", "verified": false }
}
```

## POST /api/diligence?action=site

Body: `{ "query": "300 N High St, Muncie, IN" }` or `{ "lat": 40.19, "lon": -85.38, "city": "Muncie", "state": "IN" }`,
optionally `"parcelIndex": 2` to select a listed candidate.

Returns `{ ok: true, site: <diligence.site.v1>, stage: { name: "site", ms: 812 } }`.
A city-only query returns `ok:false, error:"city_centroid"` with the resolved
city so the client can ask for an address or a map click.

## POST /api/diligence?action=evidence

Body: `{ "site": <site>, "objective": "mixed_use", "assumptions": { "coveragePct": 60, "floors": 3, … } }`.

Server re-validates the site (it never trusts client-supplied parcel geometry
as evidence: the parcel is re-read from the provider by index and point), gathers
evidence, computes scenarios, builds the baseline plan, and saves a draft run.

Returns `{ ok: true, id: "dlg_…", brief: <diligence.brief.v1 with reasoning: null>, stage: {…} }`.
Partial success is normal: unavailable sources appear as evidence rows with
`status: "unavailable"` and the brief `status` is `"partial"`.

## POST /api/diligence?action=reason

Body: `{ "id": "dlg_…" }`. Runs the model stage for a saved draft. Returns the
full brief with `reasoning` filled, or with `reasoning: null` and
`run.inference` describing why (`unavailable`, `budget_exhausted`,
`provider_rate_limited`, `provider_timeout`, `provider_unavailable`,
`output_rejected` with the rejection list, `cancelled`).

Aborting the request cancels the provider call.

## GET /api/diligence?action=get&id=dlg_…

The saved brief, owner-scoped.

## GET /api/diligence?action=list

`{ ok: true, briefs: [ { id, createdAt, updatedAt, status, site: { city, state, query }, objective } ] }`

## GET /api/diligence?action=export&id=dlg_…&format=json|html

JSON is the saved brief verbatim. HTML is a self-contained printable document
rendered from the same object by `lib/diligence/render.js`.

## POST /api/diligence?action=refresh

Body: `{ "id": "dlg_…", "reason": false }`. Re-gathers evidence for the saved
site and objective, writes a new version of the brief, and returns
`changes: [ { evidenceId, class, before, after } ]` where `class` is one of
`unchanged`, `source_changed`, `fetch_failed`, `source_disappeared`,
`extraction_changed`, `new_record`. With `reason: true` the model stage runs
again and `interpretation_changed` is reported separately. None of these is
labeled a real-world site change.
