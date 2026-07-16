---
name: API server test harness
description: Durable decisions for writing tests in artifacts/api-server.
---

# API server test harness (durable decisions)

- **Integration tests hit the REAL dev Postgres DB, not a mock DB.** drizzle's fluent query builder
  isn't worth mocking; real-DB tests are the only faithful proof of tenant isolation. Always clean up
  rows you create, and snapshot+restore any GLOBALLY-unique row (e.g. the single `app_credentials`
  provider="meta" row) so real dev config is never destroyed.
- **Mock only the trust boundary and the network**, never the DB: mock `@clerk/express` (auth) and the
  live `metaApi` network functions; keep DB-backed helpers real.
- Integration test files must run serially (they share the global meta row) and must close the pg pool
  in a top-level afterAll, or vitest hangs.
- **Contract:** `pageId`/`igUserId` are PUBLIC identifiers the API intentionally returns; only
  `appSecret` and `pageAccessToken` are secrets that must be masked and never returned/stored in
  plaintext. Don't assert IDs are masked — assert the tokens never leak (including the FB page token
  that IG rides on, which must not appear in IG responses).
- **Publish-route tests must mock the `metaApi` network test fns, not just `globalThis.fetch`.**
  The FB/IG publish routes force a live re-verification before publishing, so a fetch-only mock lets
  the forced reverify hit the real Graph API OR flip a stored credential's verifyStatus, breaking the
  gate under test. Mock `testFacebookCredentials`/`testInstagramCredentials` (default ok:true) and
  override per-test with `mockResolvedValue({ok:false})` when the case needs the token rejected.
- **Re-verification branch tests** (`socialReverify`/LinkedIn): to exercise the staleness gate, seed an
  old `verifiedAt` (helper `setAccountState`); transient failures (`transient:true` for meta, a thrown
  fetch for LinkedIn) must PRESERVE prior status and only advance `verifiedAt`; a definitive rejection
  flips to failed/error. Drive LinkedIn OAuth state via `GET /linkedin/auth/url` then feed it back to
  the callback with a spied `fetch` (token then userinfo) rather than re-signing state by hand.
- If DB inserts fail with "column ... does not exist", the dev schema is stale → `pnpm --filter
  @workspace/db run push`. If types claim `@workspace/db` lacks an export/column, rebuild lib
  declarations (`pnpm run typecheck:libs`) before the leaf typecheck.

## Public OAuth callback routers in testApp
`createTestApp()` must mount the PUBLIC callback routers (`linkedinCallbackRouter`, `twitterCallbackRouter`) before `requireTenant`, mirroring routes/index.ts — otherwise callback tests 404. On the public callback, tenant identity comes ONLY from the HMAC-signed state; do not write tests expecting session-vs-state tenant mismatch to be rejected (a validly-signed state for tenant B lands the connection on tenant B regardless of session).

- Notifications that fan out to ALL superadmin tenants (e.g. seat_request_submitted) hit REAL pre-existing admin tenants in the dev DB; per-tenant cleanup misses them. Suites triggering fan-out must purge by type+timestamp in afterAll (helper: purgeNotificationsByTypeSince in test/dbHelpers.ts), or test runs leave unread popups on the real admin account.
