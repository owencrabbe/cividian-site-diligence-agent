# Exclusions from the public edition

Generated 2026-09-29T19:31:49.980Z. The public edition is a reproducible export of one subsystem of the private Cividian repository. The following were deliberately left out.

| Excluded | Why |
| --- | --- |
| The rest of Cividian (app.html, index.html, the Studio UI, the Preact workspace, civic reports, listings, CRM, UK modules not imported by the agent, mobile builds, ops and harness directories) | Not needed to run the demonstrated functionality; proprietary product surface. |
| Private account system (lib/auth.js, private sessions registry, account erasure, Prisma, PostgreSQL) | Replaced by an isolated host (lib/diligence/standalone-host.mjs) with temporary guests and optional dedicated Supabase Auth. No private account records are exported. |
| The economic grade (lib/grade.js) | Cividian product surface the agent does not need; replaced by a stub that returns no grade, which the city read already treats as unavailable. |
| Provider credentials and every .env value | Never exported. The template contains placeholders only. |
| Private customer, property, or pilot records (Fort Wayne pilot data, evidence receipts, artifacts/, pipeline/evidence) | Private data; not part of the agent. |
| The Python NVIDIA NeMo Agent Toolkit service (services/intelligence) | A separate, earlier integration that calls NVIDIA's own endpoint; not the Nebius Token Factory path this entry demonstrates. |
| Sentry, Prometheus, observability handlers | Deployment tooling of the private product. |
| Recorded screenshots and marketing imagery | Not required to run; some are illustrative assets with their own provenance. |

Files exported from the private repository (69) are listed in MANIFEST.json with sha256 hashes. License status: Apache-2.0 authorized by the owner; third-party terms retained in NOTICE. The generated substitutes are lib/diligence/host.js, lib/auth.js, lib/grade.js.
