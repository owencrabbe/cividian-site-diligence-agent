# Public submission edition

The hackathon rules require a public source repository with an open-source
license file that contains all code needed to run the demonstrated
functionality. Cividian's repository is private and stays private. The chosen
boundary is the smallest complete one: a reproducible export of the Site
Diligence Agent subsystem, produced by `scripts/export-public-edition.mjs`
into `build/public-edition/` (gitignored), verified in place, and published to a new public repository after owner authorization.
On 2026-09-20, Apache-2.0 was chosen by the session, revisable; applying it
and publishing the export remain owner approvals.

## Why an export rather than the whole repository

- The agent is one coherent subsystem: `api/diligence.js`, `lib/diligence/`,
  `diligence.html`, the Studio finance engine it reuses, and the generic
  platform helpers it imports (request, origin, rate limit, storage, logging,
  city read, parcel providers, geocoding, county gaps).
- Everything else in the private repository (accounts, civic reports,
  listings, CRM, mobile builds, the Preact workspace, ops and harness
  directories, pilot data) is not needed to run the demo and is proprietary
  product surface with private records nearby.
- The export is computed from the import graph, not hand-picked, so it cannot
  omit a file the agent needs. It is verified by installing, testing, and
  serving it on a clean port.

## The one substitution

`lib/diligence/host.js` is the only seam between the agent and the host
platform. In the private product it re-exports Cividian's session, origin,
rate-limit, body, storage-boundary, storage, and logging helpers. In the
export it re-exports `lib/diligence/standalone-host.mjs`, which reuses the
same generic helpers and replaces the private identity system with isolated
guest sessions and optional Supabase managed accounts. Guest cookies retain
the same name, claims and lifetime; managed accounts use separate cookies and
stable provider IDs. The standalone server injects this resolver locally too. `lib/auth.js`
becomes a one-line shim so `api/guest.js` runs unchanged. No other file
differs from the private repository; the manifest records both substitutes.

## Command sequence

```bash
node scripts/export-public-edition.mjs          # export, compile, scan, verify
node scripts/export-public-edition.mjs --no-verify
```

The script:

1. computes the transitive ES-module import closure from the entry points;
2. copies those files preserving paths, writes the two substitutes, copies
   the page, docs, tests, fixtures, evaluation set, and original finance TypeScript sources;
3. compiles `studio/finance.ts` and its imports to
   `studio-runtime/studio/` so no TypeScript toolchain is needed at runtime;
4. generates `package.json` (dependencies `jose` and `redis` only),
   `.env.example` with placeholders, `.gitignore`, `README.md`,
   `EXCLUSIONS.md`, a Node 24 `server.mjs`, `vercel.json`, and proposed license/notice files;
5. scans every exported file for credential shapes, the forbidden name,
   personal email addresses, and machine paths, and fails on any hit;
6. runs `npm install --package-lock-only`, `npm ci`, `npm test`, and the
   evaluation set inside the export, then starts the standalone server on a
   random port and checks `/healthz`, the page, `GET /api/diligence`, guest
   minting, cross-origin refusal, anonymous refusal, and a guest list;
7. writes `MANIFEST.json` with sha256, size, origin, and license status for
   every final file, including the lockfile and evaluation output, plus the
   verification steps and whether the source worktree had uncommitted changes.
   Only node_modules and the self-referencing manifest are excluded.

What the export verifies: that a clean machine with Node 24 and network access
to npm can install, test, and serve the agent in fixture mode. What it cannot
prove: live Nebius inference (needs a key and approved spend), Census-backed
city evidence (needs a key), or a hosted deployment.

## Owner checklist before publishing

1. Review `LICENSE.proposed`, `NOTICE.proposed`, and `LICENSE_OPTIONS.md`.
   After Owen explicitly authorizes the license and release boundary, run
   `node scripts/export-public-edition.mjs --license-approved=Apache-2.0`.
   This writes LICENSE/NOTICE, sets package license to Apache-2.0, resolves the
   README license line, and records the license in the final manifest. The
   default export remains UNLICENSED and safe to review locally.
2. Review `MANIFEST.json`: every file marked
   `cividian-proprietary-pending-owner-license` is being released under that
   license. Remove anything you do not want public and re-run the export.
3. Review `EXCLUSIONS.md` and `README.md`.
4. Create a new public repository (GitHub, GitLab, or Bitbucket), commit the
   export contents as the initial commit, and record the source commit hash
   from the manifest in the commit message for provenance.
5. Never put credential values in files. Export privately in the launching
   terminal or set deployment environment variables. The template has names
   and placeholders only; the server does not load it.
6. Record the public repository URL in `SUBMISSION_DRAFT.md`.

Publication itself, and the license, require the owner's approval. This
branch does not create a public repository or apply a license by default.
The approval flag is reserved for the owner-authorized release step. Publish
from a separate checkout: the exporter refuses to replace an output directory
containing `.git`, so re-export cannot erase public repository history.
