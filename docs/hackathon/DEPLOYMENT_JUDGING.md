## Main-site integration, September 21

The primary experience is `/diligence` on the existing Cividian domain and
Vercel project, using the main account and brief store. Set
`DILIGENCE_BUDGET_REDIS_URL` on that deployment to the existing judging host's
Redis URL so both deployments reserve and settle against one unchanged AI
ledger. Never replace the main `REDIS_URL`: it owns existing user records.
The optional budget connection fails closed and cannot fall back to another
store when configured. No namespace prefix is applied to the shared ledger.

The approved allowance is $5 total existing/promotional credit only through
2026-12-15T20:00:00Z, $1/day, $0.25/run, concurrency three, no paid top-up.
Budget authorization does not prove provider credit remains available; the
trial observed on September 21 expires in 28 days. Judge-period credit remains
unverified until a promotional award is confirmed.

Main pre-release rollback target: `dpl_J1CD9GvyknoxbaUqZb96LNkuNnXe`.
The existing main health endpoint returned 503 before this integration. Redis
responds PONG. Broad platform readiness must not be represented as passing
until the remaining configured dependency failure is diagnosed and resolved.

# Deployment and judging plan

September 21 continuation: the original approval has expired and current
hosted status correctly reports `inference.mode: unavailable`. The first-user
beta explicitly supports evidence-only operation. A new allowance is pending;
do not treat the historical live receipt below as current AI availability.

Status on 2026-09-20: the owner-authorized dedicated deployment exists at
https://cividian-site-diligence-agent.vercel.app . Its public page, health,
and capability status respond without a Vercel login. Nebius and AUTH_SECRET
are production Secrets; the approved $1 ceiling expires after today. The
isolated Upstash Free Redis is provisioned and connected after owner terms
acceptance. Hosted status reports live inference and a Redis budget store.
The first live model response was truncated and rejected. After completion
tuning, all 12 hosted live checks passed, including model validation, exports,
reopen, guest isolation and refresh. Today's $1 spending approval expires at
2026-09-21T04:00:00Z; this does not establish December judging availability.

## Simplest viable architecture

The UI and API stay on Vercel (the existing `cividian` project already serves
`api/*` through `vercel-web.mjs`); inference runs through Nebius Token Factory
over HTTPS from the API. The rules permit this for the Best Apps and Agents
track (Nemotron via Token Factory; Nebius Serverless Endpoints or Jobs are
optional). Nothing else in the product migrates.

Nebius Serverless Jobs or Endpoints would add value only for scheduled
evidence refresh, which is deliberately manual in this entry; they are not
required and are not planned for the submission.

Two deployment shapes, both prepared:

1. Branch preview on the existing Vercel project. Pushing the branch produces
   a preview deployment if the project's Git integration is enabled. Preview
   deployments inherit the Preview environment variables; the diligence
   variables must be added there. Suitable for the video and for judges if
   the owner is comfortable exposing a preview URL.
2. A dedicated Vercel project from the public edition (`build/public-edition`
   pushed to the public repository) with generated `server.mjs`
   exporting the server from `lib/diligence/standalone-server.mjs`. `vercel.json`
   declares one Node service with an explicit entrypoint and catch-all route,
   and includes the HTML workspace, data modules, and finance runtime; the export pins Node 24.
   Isolated from production data by construction; Redis is
   required for the budget store.

## Environment variable checklist (names only)

| Variable | Purpose | Required for live judging |
| --- | --- | --- |
| `SITE_URL` | trusted origin for same-origin checks and cookies | yes |
| `AUTH_SECRET` | session signing, 32+ characters | yes |
| `REDIS_URL` | budget store, rate limits, saved briefs | yes |
| `NEBIUS_API_KEY` | Token Factory key | yes |
| `NEBIUS_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | yes |
| `DILIGENCE_LIVE_INFERENCE` | `1` | yes |
| `AI_BUDGET_APPROVAL_REFERENCE` | owner's approval note | yes |
| `AI_APPROVED_BUDGET_USD` | cumulative approved ceiling across all dates | yes |
| `AI_BUDGET_APPROVAL_EXPIRES_AT` | approved ISO expiry with timezone | required by this judging setup |
| `DILIGENCE_DAILY_BUDGET_USD` | daily cap | yes |
| `DILIGENCE_PER_RUN_BUDGET_USD` | per-run cap, default 0.25 | optional |
| `DILIGENCE_MAX_CONCURRENT` | default 3 | optional |
| `DILIGENCE_GUEST_INFERENCE` | `1` so judges need no account | yes |
| `CENSUS_API_KEY` | live city and county rows | recommended |
| `NEBIUS_CREDIT_EXPIRES_AT` | ISO expiry of the Nebius credit with timezone; live calls pause after it | optional |
| `TAVILY_API_KEY` | zoning ordinance discovery (Tavily Search and Extract); without it zoning stays `no_key` | for the zoning read (gate G3) |
| `DILIGENCE_READER_MODEL` | zoning reader, default `nvidia/Nemotron-3_5-Lightning`; must be a priced NVIDIA id | optional |
| `DILIGENCE_AUDIT_MODEL` | finding auditor, default `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`; must be a priced NVIDIA id | optional |
| `DILIGENCE_FIXTURE_MODE` | must be unset or `0` on any host; refused automatically when production-like | must not be set |

## Health, readiness, rollback

- `GET /healthz` (product runtime) or `GET /healthz` (standalone) answers
  liveness; `GET /api/diligence` answers readiness for the agent specifically:
  `inference.mode` must be `live` and `inference.budget.store` must be
  `redis`; every unmet condition is listed by name.
- Rollback: on Vercel, promote the previous deployment; the agent stores only
  `pago:diligence:*` keys with TTLs for guests, so rolling back leaves no
  schema to migrate.
- Failure states are explicit in the UI: provider rate limit, timeout,
  unavailable, budget exhausted, output rejected. The deterministic brief
  always remains.

## Weekly uptime check (by hand, never scheduled)

Nebius trial credit lasts 30 days, and judging runs 2026-12-01 to
2026-12-15. Once a week until judging ends, run from the repository root:

```bash
node scripts/diligence-uptime.mjs --out=docs/hackathon/receipts/uptime-$(date -u +%Y%m%d).json
```

It makes two free GETs per host (`/healthz` and
`/api/diligence?action=status`), with no session and no model call. It
prints one line per host and writes a metadata-only receipt: status codes,
latency, live-AI mode, the pause reason, and the shared ledger's dollars and
dates. Exit 1 means a host is down: check the Vercel deployment and Redis.
"live AI: paused" is not an outage. The deterministic brief keeps working;
the reason names what to fix:

| Pause reason | Owner action |
| --- | --- |
| `credit_exhausted` | claim or top up credit (gate G1); calls retry six hours after the refusal |
| `credit_expired` | new credit, then update or unset `NEBIUS_CREDIT_EXPIRES_AT` |
| `approved_budget_exhausted` | a new ledger approval (gate G2); never raise it without one |
| `daily_budget_exhausted` | none; resets at midnight UTC |
| `budget_store_unavailable` | check Redis |

The same ledger block is served at `/api/ai-status` (same origin) and in the
transparency panel of the workspace.

## Expected operational cost (assumptions stated)

| Item | Assumption | Estimate |
| --- | --- | --- |
| One live run | packet about 24 KB (about 8,000 tokens in), up to 3,000 tokens out, Nemotron 3 Super list price $0.30 in and $0.90 out per million (verified in the signed-in Nebius model card and price table on 2026-09-20; excluding taxes) | about $0.0051 |
| Judging period | 60 live runs per day for 15 days | about $4.59 |
| Guardrail | `DILIGENCE_DAILY_BUDGET_USD=1` is a ceiling, with conservative reservations reducing usable capacity; `DILIGENCE_PER_RUN_BUDGET_USD=0.25` blocks any single oversized run | |
| Vercel and isolated Redis | dedicated Vercel project on existing hosting; isolated Upstash Free with autoUpgrade=false and prodPack=false | no new paid database plan |

Estimates are not billed amounts. The Token Factory console is the source of
truth for spend.

## Rate and spending limits

Per IP: status 60/min, site 30/min, evidence 12/min, reason 6/min, refresh
6/min, get 60/min, list 30/min, export 30/min. Global: cumulative approved cap,
daily dollar cap, per-run cap, concurrency cap, all atomic in Redis. The
approval expiry refuses new reservations after its timestamp. Guests: 24 hour sessions, saves
expire with the session, at most 50 saved briefs per owner.

## Judge access

Judges open the deployment URL, land on `/diligence`, and a guest session is
minted automatically. No account, no subscription, no key. Live reasoning is
enabled for guests only through `DILIGENCE_GUEST_INFERENCE=1`; every other
control remains (same-origin, rate limits, budget). If the owner prefers a
private demo, the existing email sign-in can be used with a judge account and
`DILIGENCE_GUEST_INFERENCE` left unset; provide the credentials in the Devpost
submission's private testing notes.

## Data reset and isolation

Guest briefs live under `pago:diligence:brief:guest:<hash>` with a 24 hour TTL
and never touch account data. Use a fresh guest session to rehearse; old guest
briefs expire automatically. Never bulk-delete `pago:diligence:*`: budget and
reservation keys preserve the cumulative approval and must survive demo resets.
Never touch production Redis data.

## Access duration and recovery

Keep the deployment and the Redis instance alive through December 15, 2026,
12:00 pm PT. If the Nebius key is rotated, update the variable and redeploy.
If the daily budget is exhausted, judges see "budget exhausted" with the
deterministic brief; raise `DILIGENCE_DAILY_BUDGET_USD` (at or below the
approved ceiling) and redeploy. If Nebius returns 429s, the adapter retries
once and reports `provider_rate_limited`; the brief still ships.

## Activation checklist (owner)

1. Approve spend: set the approval reference and ceiling.
2. Add the variables above to the chosen deployment's environment.
3. Deploy the branch (preview) or the public edition (new project).
4. Run `npm run smoke:nebius` against the deployment's key locally, and record
   the returned model, request id, latency, and usage in VERIFICATION_RECEIPTS.md.
5. Open `/diligence` on the deployment, run the Muncie demo live, and record
   the brief id and request id.
6. Record the URL in SUBMISSION_DRAFT.md.

## Prepared acceptance command (2026-09-20)

After approval, set environment variables in the Vercel dashboard without
echoing their values. Use a dedicated Redis instance, never the private
product store. Confirm protection settings allow judges to open the stable
URL. Do not assume a successful Vercel build proves public access.

From the private branch, with the non-secret approval reference and ceiling
exported in the calling terminal:

```bash
BASE=https://your-judging-host.example npm run verify:diligence:judging -- --live
```

From the public edition the command is `npm run verify:judging -- --live`.
The checker makes one paid inference and fails unless the returned model,
request id, usage, and validated output are present. It also checks health,
Redis budget store on hosted origins, guest creation, anonymous 401,
cross-origin 403, owner isolation, both exports, reopen, and refresh. Receipts
are written to `build/judging/<timestamp>/receipt.json`. No credentials or
cookies are recorded. A local fixture receipt cannot satisfy this gate.

Fixture refusal is proven in the automated production-like environment test;
the checker verifies the real deployment is live, not a fixture. Do not turn
on fixture mode in the live judging deployment to manufacture a hosted test.

The native Node server entrypoint follows the current Vercel Services
configuration, checked 2026-09-20:
https://vercel.com/kb/guide/real-time-presence-hono-react . A bare root
`functions.server.mjs` configuration was rejected by the first hosted build
because this package has no backend framework to trigger auto-detection.
The export now declares the Node service and exports its unbound HTTP server.
The first successful build also exposed a missing `data/cities.js` runtime
dependency; `data/**` is now explicitly included. The status API and page
were verified on the corrected deployment. The export checker also verifies
fixture refusal and fail-closed workflow access without hosted Redis.

The daily cap resets in UTC. The cumulative approval ledger has no expiry and
survives dates, process restarts, and approval-reference edits. Reuse the same
isolated Redis database for local verification and hosting. Configure the
approval expiry to match Owen's authorized duration. Reservations include
the schema and both possible provider attempts; failed attempts retain their
allowance. The ledger caps list-price estimates, not the provider invoice, so
also check actual account usage and the current model prices.
If a cap is exhausted, do not silently increase it. Check authorized remaining
spend, change only within that authorization, redeploy, and rerun acceptance.
