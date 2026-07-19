---
name: Mocking platform APIs for browser e2e runs
description: How to make Threads/X publish flows succeed end-to-end in a real browser session without hitting real platform APIs.
---

**Rule:** Threads and X outbound base URLs support dev-only env overrides (`THREADS_GRAPH_BASE_OVERRIDE` in the threads routes, `TWITTER_API_BASE_OVERRIDE` in the twitter API lib), ignored when `NODE_ENV=production`. Point them at a tiny local HTTP mock that answers the probe (empty `{data:[]}`) and the create/publish endpoints with fake ids, and a browser e2e can exercise real publish/resend flows to completion.

**Why:** The publish/resend routes call graph.threads.net / api.x.com directly; with fake seeded tokens every call fails, so "flow completes and UI clears" can never be verified in a real browser otherwise.

**How to apply:**
- Run the mock as a temporary WORKFLOW, not a nohup/setsid background bash process — background processes are reaped between bash tool invocations and the mock dies mid-test (this caused two false e2e failures).
- The mock must PERSIST its request log to a /tmp file and RELOAD it on startup — validation runs restart all workflows around test runs, and an in-memory-only log (or one truncated at boot) silently loses the "exactly N platform writes" evidence after the run.
- Threads publish flow is fully mockable with just: GET /me, GET /:userId/threads → {data:[]} (dedupe probe), POST /:userId/threads → {id}, POST /:userId/threads_publish → {id}. Publishing needs no app_credentials row — only the connected_accounts row (plaintext access_token, token_expires_at NULL, provider_user_id, verify_status 'verified'). Adding an artificial ~2.5s delay to threads_publish makes the UI's in-flight disabled state observable to a browser tester.
- Set the override env vars in the `development` environment, restart the API server, run the test, then delete the vars, remove the workflow, and restart again.
- Seeding for resend: threads account row needs plaintext `access_token`, `token_expires_at` NULL (skips refresh); twitter row needs `encrypted_credentials` (encryptJson of `{accessToken, refreshToken}`) + future `token_expires_at`, plus a decryptable `app_credentials` provider='twitter' row (snapshot/remove after).
- Tenant is auto-provisioned on first authenticated page load; target it by `tenants.email` = the Clerk test login email, and clean up all seeded rows (children first) afterwards.

**Meta Ads variant:** the Meta Ads adapter honors `META_ADS_GRAPH_BASE_OVERRIDE` (non-prod only, read at call time). A reusable stateful mock lives at `scripts/src/metaAdsMockServer.mjs` (ad account act_777001, seeded "Summer Sale" campaign + insights, create/update/read; persists to /tmp). The full /ads flow (reuse-FB-connection → account pick → campaigns → draft → owner approve → change history) plus the superadmin ads switch were validated in-browser with it.

**E2E DB-seeding pitfalls (cost several false failures):**
- Never have the browser-test agent RETYPE a long encrypted blob into SQL — it mistranscribes characters and decrypt fails ("Unsupported state or unable to authenticate data"). Pre-insert a template row (e.g. tenant_id 0, platform 'e2e-template-…') and have the test copy `encrypted_credentials` via a SQL subselect; delete the template afterwards.
- Tenant provisioning is lazy and can race the test's DB seed step: make the plan explicitly POLL `SELECT id FROM tenants WHERE email=…` (up to ~30s) before inserting tenant-scoped rows; "navigate and wait for shell" alone is not enough.
- A silent 0-row `INSERT … SELECT FROM tenants WHERE email=…` is the classic symptom — always verify the insert with a count.

A reusable Threads Graph mock now lives at `scripts/src/threadsMockServer.mjs` (persists log to /tmp/threads-mock-log.json, ~2.5s publish delay) — run it as a workflow with `PORT=9099 node scripts/src/threadsMockServer.mjs` instead of rewriting one.

**Validated outcome (double-click publish guard):** a real-browser e2e with this harness confirmed a rapid double-click on the Library's Publish (dialog + card buttons) produces exactly one platform write (mock log: one container create + one publish), no 409 "already in progress" toast, and all publish buttons disabled while in flight (`publishBusy` in library.tsx + pending-state dialog button).

**Validated outcome (double-click resend guard):** same harness confirmed a real-browser double-click on the pending-posts "Resend posts" button performs exactly one resend (mock log: 1 probe + one create/publish per missing piece), no 409 toast, button disabled while in flight. React state disabling alone is NOT enough for double-clicks — the resend hook uses a synchronous ref guard that flips before re-render.
