# Exclusions from the public edition

Generated 2026-09-20T18:18:38.030Z. The public edition is a reproducible export of one subsystem of the private Cividian repository. The following were deliberately left out.

| Excluded | Why |
| --- | --- |
| The rest of Cividian (app.html, index.html, the Studio UI, the Preact workspace, civic reports, listings, CRM, UK modules not imported by the agent, mobile builds, ops and harness directories) | Not needed to run the demonstrated functionality; proprietary product surface. |
| Account system (lib/auth.js with Supabase, email sign-in, sessions registry, account erasure, Prisma, PostgreSQL) | Replaced by a guest-only session host (lib/diligence/standalone-host.mjs). The agent's saves are session-scoped in the public edition. |
| Provider credentials and every .env value | Never exported. The template contains placeholders only. |
| Private customer, property, or pilot records (Fort Wayne pilot data, evidence receipts, artifacts/, pipeline/evidence) | Private data; not part of the agent. |
| The Python NVIDIA NeMo Agent Toolkit service (services/intelligence) | A separate, earlier integration that calls NVIDIA's own endpoint; not the Nebius Token Factory path this entry demonstrates. |
| Sentry, Prometheus, observability handlers | Deployment tooling of the private product. |
| Recorded screenshots and marketing imagery | Not required to run; some are illustrative assets with their own provenance. |

Files exported from the private repository (50) are listed in MANIFEST.json with sha256 hashes. License status: Apache-2.0 authorized by the owner; third-party terms retained in NOTICE. The two generated substitutes are lib/diligence/host.js and lib/auth.js.
