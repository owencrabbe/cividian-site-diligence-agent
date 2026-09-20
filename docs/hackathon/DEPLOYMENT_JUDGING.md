# Deployment and judging plan

Status on 2026-09-20: the owner-authorized dedicated deployment exists at
https://cividian-site-diligence-agent.vercel.app . Its public page, health,
and capability status respond without a Vercel login. Nebius and AUTH_SECRET
are production Secrets; the approved $1 ceiling expires after today. The
isolated Redis connection is pending new-provider terms acceptance, so the
API correctly reports inference unavailable. This is partial hosted
verification, not a completed live judging acceptance run.

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

## Expected operational cost (assumptions stated)

| Item | Assumption | Estimate |
| --- | --- | --- |
| One live run | packet about 24 KB (about 8,000 tokens in), 1,400 tokens out, Nemotron 3 Super list price $0.30 in and $0.90 out per million (verified in the signed-in Nebius model card and price table on 2026-09-20; excluding taxes) | about $0.004 |
| Judging period | 60 live runs per day for 15 days | about $3.60 |
| Guardrail | `DILIGENCE_DAILY_BUDGET_USD=1` allows roughly 250 runs per day at list price; `DILIGENCE_PER_RUN_BUDGET_USD=0.25` blocks any single oversized run | |
| Vercel and isolated Redis | dedicated project; plan and capacity must be confirmed by Owen before provisioning | incremental cost unknown |

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
