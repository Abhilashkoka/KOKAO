---
name: E2E tenant seeding by email
description: How to reliably map a fresh Clerk test login to its tenant row for DB seeding in browser e2e tests.
---
Rule: in e2e test plans that seed tenant-scoped rows, resolve the tenant by polling `SELECT id FROM tenants WHERE lower(email) = lower(<login_email>)` (reload the app between retries) and NEVER fall back to "most recent tenant". tenants.email is stored LOWERCASED — a case-sensitive lookup on a mixed-case nanoid email returns nothing and aborts the run.
**Why:** tenants.email is a cached hint written during provisioning; it can lag the first page load. A "newest row" fallback picked an unrelated tenant and silently seeded the wrong workspace, making the UI look broken (two wasted test runs).
**How to apply:** any runTest plan with [DB] seeding after a [Clerk Auth] sign-in. Also remember: the /ads tabs (Campaigns/Approvals/History) only render when an ad_account_connections row with status='connected' exists — seed one (no credentials needed; reverify skips rows without creds).
