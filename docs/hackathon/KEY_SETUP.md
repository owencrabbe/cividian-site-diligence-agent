# Owner setup: keys and live verification

Checked against official provider documentation on 2026-09-20. Keys go into
hidden prompts in your own terminal or the dedicated deployment's environment
settings. Never paste them into chat, a source file, a shell command, or a
screenshot. No OpenAI, NVIDIA API, Supabase, or GitHub token is needed for this
standalone entry. GitHub and Vercel CLI access already works on this machine.

## 1. Nebius Token Factory: required

1. Open https://tokenfactory.nebius.com/ and sign in.
2. Select the project whose credits or billing you want the entry to use.
3. Open **API keys**, then **Get API key**. Give it a recognizable name if
   prompted, such as `cividian-hackathon`.
4. Keep the new key private. Nebius shows it once. The terminal setup below
   asks for it as `NEBIUS_API_KEY` with input hidden.
5. In https://tokenfactory.nebius.com/models/catalog confirm access to
   `nvidia/nemotron-3-super-120b-a12b`. Check its current input/output prices
   at https://tokenfactory.nebius.com/pricing before approving inference.
   The Super list prices of $0.30/$0.90 per million tokens were verified in
   the signed-in model card and organization price table on 2026-09-20.
   They exclude applicable taxes and remain usage estimates, not invoices. Do not select a paid
   dedicated endpoint or add a payment plan just to complete these steps.

Sources: https://docs.tokenfactory.nebius.com/quickstart and
https://dev.nebius.com/cookbook/opencode-nebius-token-factory .

Hackathon credits: the official resources page offers $25 Token Factory
credits through https://nebius.com/promo-code using activation code
`NEBIUS-DEVPOST-GLOBAL26`, plus another $25 through the free Builder Program
at https://dev.nebius.com/builders . These credits have not been claimed or
applied by this session. Verify the awarded balance and expiry after claiming;
the current 29-day trial alone does not cover December judging. Source:
https://nebiusglobalaihackathon.devpost.com/resources .

## 2. Isolated Redis: required for the owner setup and hosting

1. Open https://cloud.redis.io/ and sign in or create your account yourself.
2. Create a separate database named `cividian-hackathon`. Choose **Free
   30 MB Essentials** if offered and suitable. Review the selected price
   before creating it. Do not reuse the private Cividian production database.
3. When the database is active, choose **Connect** and the Redis client / TCP
   connection instructions. Copy the full connection URL privately.
4. Supply that URL as `REDIS_URL` in the hidden terminal prompt. It begins
   `redis://` or `rediss://` and includes the database credentials and port.
   An HTTPS REST endpoint is not compatible with this node-redis adapter.
5. Use this same dedicated database for local live verification and the
   hosted judging project. That keeps both processes on one total-spend
   ledger. Keep the database available through judging.

Official instructions: https://redis.io/docs/latest/operate/rc/rc-quickstart/ .

Redis Cloud permits only one free database per account. If that slot is
already used, do not attach the judging project to an existing production
database. An alternative is Upstash for Redis through Vercel Marketplace:
select the Free plan, disable automatic paid upgrades, disable eviction to
preserve the spending ledger, and keep the production pack off. Review its
separate provider terms before installation. Use the Redis TCP/TLS URL, not
the REST URL. With CLI provisioning, pass `--no-env-pull` so credentials are
installed on the project without creating a local environment file.

Sources: https://redis.io/docs/latest/operate/rc/databases/create-database/create-free-database/
and https://upstash.com/docs/redis/howto/vercelintegration .

## 3. Census: optional

Request a free key at https://api.census.gov/data/key_signup.html . Use the
activation link in the Census email, then paste the activated key into the
optional hidden `CENSUS_API_KEY` prompt. You can press Enter to skip it;
city/county rows will honestly report unavailable instead of invented values.

Official instructions:
https://www.census.gov/data/developers/guidance/microdata-api-user-guide/api-key.html .

## 4. Start the live verifier in your own terminal

From this worktree, with Node 24 selected:

```bash
nvm use
npm run setup:diligence:live
```

The public edition exposes the same command as `npm run setup:live`.

The command prompts for the three credentials above, a total USD ceiling,
and an exact expiry. Example proposed values are `5` and
`2026-12-16T08:00:00Z` (the end of December 15 in Pacific time). These are
examples, not existing spend authorization. Type `APPROVE` only if you
authorize that ceiling, expiry, one smoke call, and subsequent demo calls.
It sets daily/per-run caps to at most $1/$0.25 and allows three concurrent
calls. A smaller total reduces those caps automatically.

The command then:

- Checks the isolated Redis connection before any paid request.
- Generates an ephemeral session-signing secret in process memory.
- Records your approval metadata and runs one budgeted Nebius smoke.
- Writes only metadata to `build/live-setup/<timestamp>/approval.json` and
  `smoke.json`. These files contain no credentials or model response text.
- Starts http://localhost:3412/diligence in live mode after a successful smoke.

Leave that terminal open and tell Codex **"the local live server is ready"**.
Codex can verify and record the browser journey without receiving the keys.
An export in another terminal cannot alter an already-running Codex process.
Ctrl+C stops the server; rerunning requires re-entering credentials unless
they are already privately available in that terminal's environment.

If setup fails, share only the named failure or the metadata receipt. Do not
share a terminal dump containing secrets. The command never prints transport
exception details and never automatically retries a failed smoke command.
The provider adapter may make its one bounded retry within that command,
which is included in the reservation.

## 5. Hosted variables after release approval

The approved Vercel project is `cividian-site-diligence-agent` under
`owencrabbes-projects`. Open
https://vercel.com/owencrabbes-projects/cividian-site-diligence-agent/settings/environment-variables
and use the dedicated project's Production environment. Nebius and session
signing credentials have been configured as Secret values. A successful
build is not proof of Redis readiness or qualifying live inference.

Set `NEBIUS_API_KEY`, the same isolated `REDIS_URL`, and optional
`CENSUS_API_KEY` as sensitive values. For `AUTH_SECRET`, generate a new value
directly into the macOS clipboard, then paste into the sensitive environment
field. This command displays no secret and creates no secret file:

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' | pbcopy
```

Clear the clipboard after pasting. Do not reuse the private product's secret.
The non-secret variables and activation checks are in DEPLOYMENT_JUDGING.md.
Changes require a new deployment. Do not use `vercel env pull`, which writes
secrets to disk. Codex will inspect names/presence and actual application
behavior, not retrieve your secret values.

## Spending semantics

`AI_APPROVED_BUDGET_USD` is a cumulative ceiling in the shared Redis database,
across dates and approval-note edits. Daily caps reset at UTC midnight; the
total ledger does not expire. `AI_BUDGET_APPROVAL_EXPIRES_AT` stops new calls
at its timestamp. Keep this expiry configured for the judging deployment.
Reservations include schema input, output allowance, and both possible
provider attempts. Failed calls retain their allowance. A duplicate
settlement cannot charge the ledger twice.

The ledger caps estimates from dated list prices, not the provider's invoice.
Check actual provider usage and account controls as well. Never clear budget
or reservation keys, switch Redis databases, or raise caps to evade an
exhausted approval. A local in-memory store resets on process exit, so the
owner setup requires Redis even for local live verification.
