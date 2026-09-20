# Cividian Site Diligence Agent (public edition)

An evidence-first development diligence copilot. Give it a site and a
development objective; it resolves the site identity, gathers sourced evidence,
computes deterministic scenarios, asks NVIDIA Nemotron on Nebius Token Factory
to reason over a bounded evidence packet, validates every citation, and
produces a ten-section decision brief with a prioritized investigation plan.

Decision support only. Nothing here determines legal entitlement, zoning
compliance, investment suitability, engineering feasibility, or financial
performance. Missing values stay null; nothing is estimated in their place.

LICENSE: Apache-2.0. See LICENSE and NOTICE.

For live provider signup and private credential setup, follow
[the key setup guide](docs/hackathon/KEY_SETUP.md). With Node 24 installed,
`npm run setup:live` prompts privately, records explicit spending approval,
runs a budgeted smoke, and starts the local live demo.

## What this package is

A reproducible export of the Site Diligence Agent subsystem from the private
Cividian repository. It contains every source file the agent imports, a
standalone guest-session host in place of Cividian's account system, the
compiled Studio finance engine the scenarios reuse, the workspace page, the
test suite, the evaluation set, and the Nebius smoke test. `MANIFEST.json`
lists every file with its sha256 and origin; `EXCLUSIONS.md` names what was
left out and why.

## Quickstart

Node 24 (`nvm use` if you use nvm).

```bash
npm ci
npm test                         # contract and behavior tests, no network
npm run eval                     # curated evaluation set, no network
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
DILIGENCE_FIXTURE_MODE=1 npm start
```

Open http://localhost:3000. The header says which mode the reasoning stage is
in. With `DILIGENCE_FIXTURE_MODE=1` and no Nebius key, the model stage is a
clearly labeled rules-based fixture that exercises the same validator a live
answer must pass. It is refused on any production-like host.

## The demo in five steps

1. Enter `300 N High St, Muncie, IN` and resolve the site. Indiana parcels
   come from the State of Indiana's public IndianaMap layer, so no parcel
   provider key is needed there. Elsewhere the parcel row says `no_key` or
   `no_coverage` and lot area can be entered as a labeled assumption.
2. Choose an objective and enter a hard cost, a rent, and a cap rate (all
   labeled user assumptions). Leave the rest at their labeled defaults.
3. Run. The stage list shows real timings for site, evidence and scenarios,
   reasoning, and validation.
4. Read the evidence panel (site rows versus context rows), the scenario
   comparison, and the brief. Click any `[ev_…]` chip to inspect the record.
5. Open the printable brief or download the JSON. Refresh evidence to see
   per-record change classes. Everything you saved is listed under Saved
   briefs for the guest session's 24 hours.

## Live Nemotron on Nebius Token Factory

Export these in your terminal or configure the deployment environment, then restart.
Never paste credentials into chat, command history, or files. `.env.example`
is a names-only reference; the server does not load an environment file.

Set every one of these:

| Variable | Value |
| --- | --- |
| `NEBIUS_API_KEY` | your Token Factory key (server only) |
| `NEBIUS_MODEL` | `nvidia/nemotron-3-super-120b-a12b` (default) or another `nvidia/` id you are entitled to |
| `DILIGENCE_LIVE_INFERENCE` | `1` |
| `AI_BUDGET_APPROVAL_REFERENCE` | a note naming who approved spend and when |
| `AI_APPROVED_BUDGET_USD` | cumulative approved ceiling across dates, for example `5` |
| `AI_BUDGET_APPROVAL_EXPIRES_AT` | approved ISO expiry with timezone; required by the owner setup |
| `DILIGENCE_DAILY_BUDGET_USD` | at or below the ceiling, for example `1` |
| `DILIGENCE_GUEST_INFERENCE` | `1` to let guest sessions trigger live reasoning (judging) |
| `REDIS_URL` | required on any deployed host; the in-process budget store is local only |

`GET /api/diligence` lists which conditions are unmet, by name. Prove the
connection with one tiny request:

```bash
npm run smoke:nebius
```

City evidence (Census ACS, County Business Patterns) needs `CENSUS_API_KEY`;
without it those rows are honest `unavailable` rows and the brief still runs.

## Architecture

See `docs/hackathon/ARCHITECTURE.md` (contracts, validation rules, the live
inference gate) and `docs/hackathon/API.md` (the HTTP surface). Modules live in
`lib/diligence/`; the HTTP handler is `api/diligence.js`; the page is
`diligence.html`; the standalone server is `lib/diligence/standalone-server.mjs`.

## Limitations

- Zoning envelopes come from commercial providers Cividian has not licensed;
  the zoning row is unavailable and the plan says what to verify and with whom.
- Parcel coverage without a provider key is Indiana only (public state layer).
- Guest saves last 24 hours. There is no account system in this edition.
- Refresh is manual. Nothing runs on a schedule.
- Cost figures are list-price estimates tied to a dated table, never billed
  amounts.
- Third-party notices: `docs/hackathon/THIRD_PARTY_NOTICES.md`.

## Judging verification

The generated `server.mjs` starts the standalone server locally and exports
an unbound Node HTTP server on Vercel. `vercel.json` declares a single Node
service with this explicit entrypoint, routes requests to it, and includes
the workspace and compiled finance runtime. Set `SITE_URL` to the
exact origin, `AUTH_SECRET`, and an isolated `REDIS_URL` on the deployment.
Do not copy credentials or project links from the private product.

After spend is approved, run from a terminal with the approval reference and
ceiling exported:

```bash
BASE=https://your-judging-host.example npm run verify:judging -- --live
```

This makes one billable reasoning request and saves a metadata-only receipt
under `build/judging/`. It checks guest isolation, exports, reopen, and a
refresh without a second inference. Fixture rehearsal is local only:

```bash
BASE=http://localhost:3000 npm run verify:judging -- --fixture
npm run test:redis  # optional; starts its own local redis-server, never uses your REDIS_URL
```

A successful local export is not proof of hosted acceptance. See
`docs/hackathon/DEPLOYMENT_JUDGING.md` for activation and recovery.
