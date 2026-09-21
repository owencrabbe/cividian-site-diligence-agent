# Activate accounts, user API keys and MCP

The website is `/`, the installable web app is `/app`, sign-in is `/login`,
connections are `/account`, and the user guide for integrations is `/developers`.
They use one Vercel project and origin. The legacy `/diligence` URL still works.
No second Vercel project or DNS change is needed for this route layout.

The deployed account integration stays disabled until a dedicated managed-auth
project is configured. Guest access remains available. A synthetic test session
is not proof of a real provider login. Do not invite users to create keys until
the live acceptance sequence below succeeds.

## 1. Dedicated managed identity project

Open [Supabase projects](https://supabase.com/dashboard/projects). Create a
project named `cividian-site-diligence-auth` in the owner-selected organization.
Check the actual project price before creating it. Do not restore or repurpose
an unrelated old project. The owner must select the organization and accept the quoted price before
provisioning. Account-service activation on the hosted pilot is still pending.

This project supplies Auth only. Briefs and hashed API keys stay in the existing
isolated Redis database. Do not create public tables or copy private Cividian
user data. Never put a Supabase service-role key in this app.

In Supabase's project settings, obtain the project URL and **publishable** key
(the `sb_publishable_` key, not a secret/service-role key). In the existing
[Vercel project's environment settings](https://vercel.com/owencrabbes-projects/cividian-site-diligence-agent/settings/environment-variables),
set production variables through the secure value fields:

- `DILIGENCE_SUPABASE_URL`: the project HTTPS origin.
- `DILIGENCE_SUPABASE_PUBLISHABLE_KEY`: its publishable key.
- `DILIGENCE_EMAIL_AUTH_ENABLED=false` until email is tested.
- `DILIGENCE_GOOGLE_AUTH_ENABLED=false` until Google is tested.
- `DILIGENCE_GITHUB_AUTH_ENABLED=false` until GitHub is tested.

Retain the existing `AUTH_SECRET`, `REDIS_URL`, `SITE_URL` and Nebius settings.
Do not pull secret values into a file or paste them into chat. Enabling account
sign-in does not authorize model spend.

## 2. Sign-in method

At least one provider must be configured and tested before its app flag becomes
`true`. Use the current origin
`https://cividian-site-diligence-agent.vercel.app` until a custom domain is
explicitly selected. Set it as the Auth Site URL. Allow only this deployment's
callback route in Auth URL Configuration:
`https://cividian-site-diligence-agent.vercel.app/api/account**`.
The suffix permits the fixed callback action and random state query. Do not use
a wildcard host or allow all preview domains. The app independently verifies
browser-bound state and PKCE, and redirects to its own `/account` route.

### GitHub, useful for an initial developer pilot

1. Open [GitHub OAuth applications](https://github.com/settings/developers) and
   register a dedicated OAuth app named Cividian Site Diligence.
2. Homepage: the website origin above. Authorization callback:
   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`, copied from the
   Supabase GitHub provider panel. Leave Device Flow off.
3. Put the client ID and generated secret directly into Supabase Authentication
   > Sign In / Providers > GitHub and enable that provider. Do not store them
   in Cividian, chat, or the repository.
4. Set `DILIGENCE_GITHUB_AUTH_ENABLED=true` on the Vercel deployment and redeploy.
5. Complete one real GitHub sign-in in the browser and run the acceptance steps.

Reference: [Supabase GitHub setup](https://supabase.com/docs/guides/auth/social-login/auth-github).

### Email codes, useful for general users

1. Configure an authenticated sending domain and custom SMTP service in
   Supabase Authentication > Email. Supabase's default sender is limited to
   project-team addresses and is not a public-user delivery service.
2. In the Magic Link email template, include `{{ .Token }}` as the code. The
   default magic-link template does not match this app's code-entry screen.
3. Set Email OTP expiration to 600 seconds. Retain provider rate limits. The
   app also limits each browser-bound attempt to five guesses and ten minutes.
4. Test delivery to an address outside the Supabase team. Set
   `DILIGENCE_EMAIL_AUTH_ENABLED=true` and redeploy only when that works.

References: [email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)
and [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). Configure
Google later through the same Auth Providers screen and a dedicated OAuth app;
set its app flag only after completing the real flow.

## 3. Live account and connection acceptance

1. Sign in at `/login`. Confirm `/app` says signed in and account briefs survive
   a new browser login. Guest briefs do not migrate; export them before login.
2. Create a read key at `/account`, save it in the client's secret settings,
   and confirm it reads only the signed-in account's saved briefs. It must fail
   to create a brief. The raw key is shown once and never stored by the server.
3. Use a read-and-create key to create one evidence-only brief. It must appear
   in that account's Saved briefs, with no paid inference.
4. Connect the remote MCP endpoint `/api/mcp` using the Bearer header and call
   `tools/list`, `cividian_list_briefs`, and `cividian_get_brief`. Test with a
   client that supports custom headers; OAuth-only clients are not supported.
5. Revoke the key. Both REST and MCP must return 401 on the next request.
6. Sign out and sign in again. Saved account work should remain accessible.
   Signing out does not revoke separate API keys; use their Revoke controls.
7. Record only statuses, version, deployment ID and check names. Never record
   session cookies, provider tokens or the raw API key in acceptance artifacts.

Local contract tests use a scripted identity provider. Browser account tests use
synthetic responses and explicitly label that scope. Neither substitutes for
this live acceptance sequence.

## Domain and native app

For a custom domain, attach the owner-selected domain to this existing project,
update `SITE_URL`, Auth Site URL and callback allowlist together, and rerun login
and origin checks. Do not attach `cividian.com` or change its current product
without an explicit domain choice. Cross-domain guest cookies do not migrate.

The app is an installable web app with a manifest and network-only service
worker. It requires connectivity and does not cache private briefs or keys.
Native iOS/Android packages and App Store distribution are separate work and
are not claimed as delivered by this release.

## Account suspension

User API keys are separate credentials, so a provider logout does not revoke
them. Before deleting or disabling a provider user, revoke the app keys and
set that user's existing `pago:diligence:account:<hashed-id>` record to inactive
through the approved operator process. Provider-side deletion alone is not an
app-key revocation event. The app refuses an inactive account and never revives
it on a later login. There is no public account-deletion endpoint in this pilot.
