# Main-site API and MCP integration

The Cividian deployment uses its canonical account and `cvd_sk_` keys, managed
at `/account`. The shared REST/MCP registry publishes these capabilities:

| Capability | REST | MCP tool | Scope |
| --- | --- | --- | --- |
| Resolve site | POST `/api/v1/diligence/sites` with `query` | `diligence_resolve_site` | read |
| Create brief | POST `/api/v1/diligence/briefs` with `query`, optional `objective`, `assumptions` | `diligence_create_brief` | read + diligence.write |
| List saved briefs | GET `/api/v1/diligence/saved` | `diligence_list_briefs` | read |
| Read saved brief | GET `/api/v1/diligence/briefs?id=...` | `diligence_brief` | read |

All four require a verified account. The raw API key is shown once and stored
only as a hash. Revocation, account erasure and ownership rules remain in the
existing credential layer. Creation is limited to six per minute and fifty per
day per account across keys and transports. API/MCP never initiate paid model
calls. Full current schemas: `/openapi.json`; setup: `/developers`; MCP: `/mcp`.

The standalone public edition retains its independent, optional managed-account
adapter and `cvd_dlg_` keys. Those credentials do not authenticate to the main
site. Its code and guest judging path remain reproducible without private
Cividian account infrastructure.

---

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
  "session": { "kind": "guest | account | none", "verified": false, "expiresAt": "ISO guest expiry or null" }
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

`{ ok: true, briefs: [ { id, createdAt, updatedAt, expiresAt, status, site: { city, state, query }, objective } ] }`

## POST /api/diligence?action=remove

Body: `{ "id": "dlg_…" }`. Owner-scoped, same-origin, rate-limited removal.
Returns `{ ok: true, removed: true }` after removing the brief's content and
index entry. A missing or another owner's id returns `not_found`. GET cannot
remove anything. A content-free marker prevents an already running write
from recreating the removed brief (`brief_removed`). Guest markers expire
with the signed session. A session that expires during a write returns 401.

Brief and index updates are atomic in Redis. Guest records carry `expiresAt`
and their TTL never extends beyond the signed session's expiry. The public
edition has no account recovery or cross-device sharing. Downloaded files
and provider-side processing are not removed by this API.

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

## Standalone account and integration APIs (agent 0.4.0)

`/api/account` is a cookie-authenticated, same-origin account surface. GET
`action=status` returns provider availability and the signed-in display identity;
GET `action=keys` lists key metadata. POST actions are `send-code`, `verify-code`,
`oauth`, `logout`, `create-key` and `revoke-key`. OAuth completes at GET
`action=callback` with PKCE and browser-bound state. Provider sessions are
HttpOnly cookies; expired accounts do not downgrade to guests. A raw user API
key appears only in the creation response, never subsequent lists.

REST and MCP authenticate **only** an `Authorization: Bearer` user API key,
not a browser cookie or URL parameter. GET `/api/openapi.json` is the public
schema, and `/developers` has examples. Endpoints:

| Method | Path | Required scope |
| --- | --- | --- |
| GET | `/api/v1/capabilities` | `diligence:read` |
| POST | `/api/v1/sites/resolve` | `diligence:read` |
| POST | `/api/v1/briefs` | `diligence:write` |
| GET | `/api/v1/briefs` | `diligence:read` |
| GET | `/api/v1/briefs/{id}` | `diligence:read` |

POST `/api/mcp` exposes the matching five `cividian_*` tools, using Streamable
HTTP JSON responses. Supported protocols are 2026-07-28, 2025-11-25 and
2025-06-18. Modern requests require protocol/client metadata and matching
MCP headers. Legacy clients initialize normally. Only keys with write scope
see the create tool. There is no OAuth discovery or unauthenticated SSE stream.
Use clients with custom Bearer headers. Batch messages are refused.

Account limits: 120 reads/minute, 6 creations/minute, 50 creations/day, across
all keys. Additional IP limits apply. A read key cannot create, another
account's brief looks absent, and revocation takes effect on the next request.
Keys expire after 90 days with a maximum of five active keys per account.
API/MCP creation saves evidence, calculations and rules-based priorities;
it never invokes paid inference. See ACCOUNT_SETUP.md for activation gates.
