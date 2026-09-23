# September 22 integrated release hardening

This integrates the handoff reader, auditor, live benchmark and submission PRs with the already released civic platform. It retains the handoff interfaces, three separately priced text models (Super, Lightning reader, Nano 30B auditor), constructed jurisdiction fixtures, verified benchmark points and public-export machinery. It does not substitute the parallel prototype implementation.

## Corrections before release

- Every Tavily API entry point, including fixture recording, now requires separate explicit credit approval and atomically reserves Basic Search (1), Advanced Search (2), Basic Extract (1 per five URLs) or Advanced Extract (2 per five URLs). Failed/uncertain attempts remain charged. Counters are recorded before dispatch. The Redis total persists across days and hosts. Configuration is off by default; no spending allowance or key was created.
- The optional PDF fetch honors the caller deadline (also retaining its independent eight-second cap), pins an allowed public IPv4 address and refuses private/special ranges, redirects, credentials, nonstandard ports, compression and over-limit responses. Tests use a small injected DNS result, not a resource-exhaustion probe. Hashing document bytes does not independently authenticate Tavily's extracted text; ordinance rows remain unverified.
- The auditor locally validates the entire schema, one unique verdict per input, exact disputed substrings and receipt metadata. Malformed output is audit unavailable. Provider exceptions settle the conservative reservation and preserve labeled evidence. A finding cannot mix an unverified ordinance citation with a confirmed citation to evade the deterministic gate.
- Benchmark preflight includes the remaining daily allowance, configured model prices, Unicode byte bounds and a separate Tavily batch allowance. A failed or empty canary stops later modes. An unavailable reader or auditor prevents the full-agent mode from claiming completed acceptance. Failed runs retain metadata receipts. Local drafts use a unique guest workspace and are removed after each mode. The live CLI requires the existing shared budget store and a verified sufficient provider-credit balance; it refuses hosted execution or shared account storage. Numeric overlap remains explicitly limited and is not called factual accuracy.

## Verification

The integrated diligence suite passes 103 tests, including benchmark preflight refusals and degraded-stage acceptance. The separate Redis suite passes, including concurrent Tavily caps and day rollover. Lint passes without warnings. `npm run verify:release` and `npm run check:privacy` pass. The public export passes all 16 verification steps, including its isolated install, tests and evaluation cases. All 16 scripted evaluation cases pass, including malformed-audit refusal.

Local fixture acceptance passes 15 API/workflow checks, including exports, reopen, refresh and guest isolation. The desktop browser rehearsal passes all ten shots with zero page errors. Mobile at 390 by 844 pixels creates a saved brief, has no horizontal overflow and reports no browser errors. These are explicitly fixture results.

The free provider check resolves all 24 benchmark sites; five use their documented Census point fallback. Some parcel matches remain nearest candidates or address matches, not verified containing polygons. The no-spend preflight estimates a $2.199936 reservation upper bound for all three modes on 24 sites, above the existing $1 daily cap and observed provider credit. The paid benchmark remains NOT RUN.

The production owner acceptance used the existing authenticated account through normal UI: a labeled synthetic project saved and survived reload; version-one PDF and worksheet downloaded; the PDF hash/unknown checks matched; the worksheet correctly had no scenarios. Anonymous requests to both exports returned 401. The metadata receipt is retained in the private civic-development release records. This does not establish a city pilot, native Excel recalculation, second-tenant acceptance or email delivery.

## Activation limits

No new live Tavily, Lightning or Nano structured-output acceptance is claimed by these fixture tests. Main-site Nebius key installation, Tavily authorization, additional provider credit for a full 24-site benchmark, native Excel, actual city-pilot consent and billing-provider acceptance remain distinct from a software release. The current Nebius provider trial showed about $0.99 and 27 days remaining. Existing application caps stay $5 cumulative, $1/day, $0.25/run and concurrency 3. No top-up or increased cap was purchased.

The public video/Devpost submission still needs the actual public URL, personal eligibility/team facts and a submission receipt. Historical private-file deletion remains separate from rewriting Git history. The prior resource-exhaustion review rejection was not retried.

## Integration rollout

PR #118 merged as `42e2f4085f7ad93a7069fac4b5a146cacbe01cc1` after all nine
required checks, both Vercel previews, code review and the full local release
suite passed. The amd64 container build and runtime smoke also passed; the
advisory multi-architecture build was still running at this checkpoint.

The controlled audit UI check passed at 1440 and 390 pixels: exact disputed
words are struck through, keyboard-focusable and labeled partly supported,
with no overflow or browser exceptions. The receipt explicitly identifies
the response as a local fixture. This is not live model evidence.

The other release session's September 22 hosted receipt proves Super reasoning
and a Nano 30B audit on public commit `27d9217`, before the stricter audit
checks in this patch. That dated receipt is retained separately. The public
update with these safeguards is tracked in public-edition PR #2.
