---
name: E2E tenant seeding by email
description: How to reliably map a fresh Clerk test login to its tenant row for DB seeding in browser e2e tests.
---
Rule: in e2e test plans that seed tenant-scoped rows, resolve the tenant by polling `SELECT id FROM tenants WHERE lower(email) = lower(<login_email>)` (reload the app between retries) and NEVER fall back to "most recent tenant". tenants.email is stored LOWERCASED — a case-sensitive lookup on a mixed-case nanoid email returns nothing and aborts the run.
**Why:** tenants.email is a cached hint written during provisioning; it can lag the first page load. A "newest row" fallback picked an unrelated tenant and silently seeded the wrong workspace, making the UI look broken (two wasted test runs).
**How to apply:** any runTest plan with [DB] seeding after a [Clerk Auth] sign-in. Also remember: the /ads tabs (Campaigns/Approvals/History) only render when an ad_account_connections row with status='connected' exists — seed one (no credentials needed; reverify skips rows without creds).

## Member-join + studio e2e lessons (browser harness)
- Clerk ticket sign-in works headlessly: backend-create user, PATCH email verified:true, POST /v1/sign_in_tokens, then in-page `Clerk.client.signIn.create({strategy:'ticket',ticket})` + setActive. No CAPTCHA/client-trust issues.
- Invite auto-accept silently falls through to a personal tenant when the plan has 0 team seats (free plan teamSeats=0). Seed `tenants.seat_limit` (e.g. 3) on the workspace BEFORE the member's first sign-in.
- Block `**/api/**` routes during sign-in and fire ONE controlled /api/me afterwards so provisioning/invite-accept can't race parallel first requests.
- A fresh member's first /studio visit stacks blocking dialogs (consent "Your data, your choice" → welcome wizard). Dismiss in a loop matching buttons /got it|skip|continue/ before clicking anything.
- Feature-flag flips need a 30s wait: the api-server caches feature_flags in-process (CACHE_TTL_MS 30s).
