---
name: API route integration tests
description: How to write end-to-end confirmation tests for api-server routes that call external APIs.
---

# API route integration tests (api-server)

api-server uses **vitest** (`pnpm --filter @workspace/api-server run test`). The
LinkedIn publish flow has the first example: `src/routes/<name>.test.ts`.

**Why:** "Confirm X publishes end-to-end" tasks can't hit the real provider
(needs an approved app + live token), so drive the ACTUAL router with the
provider's HTTP calls and object storage mocked. This gives durable regression
cover for the parts that only fail for real users (escaping, image upload init,
DB status flips).

**How to apply (pattern proven in linkedin.test.ts):**
- Mock `@workspace/db` with `importOriginal` so REAL table objects + `eq`/`and`
  still work; swap only `db` for an in-memory fake keyed by `getTableName(table)`
  (`connected_accounts` / `content_items`). Fake ignores where-conditions and
  mutates the seeded row (enough because tests seed one tenant/one row).
- Mock `../lib/objectStorage` so `getObjectEntityFile().download()` returns
  `[Buffer]`.
- Mock `global.fetch` to route by URL and record calls (assert request bodies,
  e.g. commentary escaping, `content.media.id`).
- Drive the router over `node:http` (mount on a bare express app, set
  `req.tenantId`/`req.log` in middleware, `app.listen(0)`) — NOT `fetch` — so the
  `global.fetch` mock only intercepts the router's OUTBOUND provider calls.
- tsconfig has `types:["node"]`, so DOM globals like `RequestInfo` are absent —
  use `Parameters<typeof fetch>[0]` instead.
