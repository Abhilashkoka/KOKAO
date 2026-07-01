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
- If DB inserts fail with "column ... does not exist", the dev schema is stale → `pnpm --filter
  @workspace/db run push`. If types claim `@workspace/db` lacks an export/column, rebuild lib
  declarations (`pnpm run typecheck:libs`) before the leaf typecheck.
