---
name: Mocking platform APIs for browser e2e runs
description: How to make Threads/X publish flows succeed end-to-end in a real browser session without hitting real platform APIs.
---

**Rule:** Threads and X outbound base URLs support dev-only env overrides (`THREADS_GRAPH_BASE_OVERRIDE` in the threads routes, `TWITTER_API_BASE_OVERRIDE` in the twitter API lib), ignored when `NODE_ENV=production`. Point them at a tiny local HTTP mock that answers the probe (empty `{data:[]}`) and the create/publish endpoints with fake ids, and a browser e2e can exercise real publish/resend flows to completion.

**Why:** The publish/resend routes call graph.threads.net / api.x.com directly; with fake seeded tokens every call fails, so "flow completes and UI clears" can never be verified in a real browser otherwise.

**How to apply:**
- Run the mock as a temporary WORKFLOW, not a nohup/setsid background bash process — background processes are reaped between bash tool invocations and the mock dies mid-test (this caused two false e2e failures).
- Set the override env vars in the `development` environment, restart the API server, run the test, then delete the vars, remove the workflow, and restart again.
- Seeding for resend: threads account row needs plaintext `access_token`, `token_expires_at` NULL (skips refresh); twitter row needs `encrypted_credentials` (encryptJson of `{accessToken, refreshToken}`) + future `token_expires_at`, plus a decryptable `app_credentials` provider='twitter' row (snapshot/remove after).
- Tenant is auto-provisioned on first authenticated page load; target it by `tenants.email` = the Clerk test login email, and clean up all seeded rows (children first) afterwards.
