---
name: Resilient api-client test mock
description: How socialforge page tests mock @workspace/api-client-react without going stale when new hooks are added.
---

All socialforge tests that mock `@workspace/api-client-react` must use the shared Proxy helper (`src/test/apiClientMock.ts`, `createApiClientMock(overrides)`) instead of hand-listing every hook in a `vi.mock` factory.

**Why:** hand-listed mocks silently went stale — every new hook imported by a page broke 9+ unrelated tests with "No <hook> export is defined".

**Enforced:** a guard test (`src/test/apiClientMockGuard.test.ts`) scans all test files and fails the suite if any `vi.mock` of the module lacks `createApiClientMock` — don't bypass it, use the helper.

**How to apply:** in the `vi.mock` factory, `await import` the helper (vi.mock is hoisted, so no top-level import) and pass only the hooks the test actually observes. Unknown `use*` exports fall back to an idle mutation/query stub, `get*QueryKey` to a stable key, other unknowns to `vi.fn()`; utility exports (`mutateWithRestartRetry` etc.) have real-shaped defaults. The Proxy returns `undefined`/`false` for `default`/`__esModule`/`then` probes so vitest module interop stays happy.
