---
name: API test database isolation
description: Why API tests must not borrow Preview configuration or customer data.
---

Run API fixtures in an empty, disposable local PostgreSQL cluster, never against
Preview or production. Use source schemas, not a copy of customer data.

Browser tests and manual E2E seeders must also use a separately running,
disposable app, not merely an isolated SQL connection.

**Why:** a browser can still mutate shared singleton settings through the
Preview API even when its fixture SQL is isolated. Matching app/database
targets must be checked before either API or SQL side effects.

**How to apply:** follow `docs/browser-test-isolation.md`. Keep development
Clerk authentication but exclude inherited paid-provider, storage, and payment
credentials. Verify concurrent edits using two scratch apps; observe real
Preview read-only rather than performing test admin edits there.

HTTP/HTML status checks are insufficient for a browser harness serving the SPA
through the API app.

**Why:** API Helmet CSP blocked Clerk; a cold Vite middleware server served
outdated dependency chunks. A directory-order Chromium fallback also selected
an old browser that did not retain Clerk's partitioned cookies. Selecting the
newest regular Chromium fixed cookie-authenticated sign-in and reload.

**How to apply:** verify Clerk session persistence and cookie-authenticated admin
writes in current Chromium before treating a new test origin as usable. Keep
failures visible; do not replace this check with bearer-only success or infer
that loopback authentication is unsupported from an old-browser failure.

**Why:** snapshot-and-restore still exposed transient enforcement prices to
active Preview requests and could overwrite legitimate concurrent admin edits.
Even an exclusive test lock does not exclude the running app or its admins.

**How to apply:** keep isolation before all app/database imports and all setup
hooks, including direct Vitest invocations. Missing local PostgreSQL tooling must
fail closed. Interrupted runs should discard their private data, not restore
shared state. Do not automatically replay a pre-isolation orphan snapshot;
review it against current admin settings first. Historical shared-database
test-race advice no longer applies across isolated API runner invocations.

When making remote-DB tests run locally, seed explicit nonzero pricing inputs
and mark scheduler fixtures due rather than relying on connection latency.

**Why:** an empty database exposed tests borrowing admin FX, estimate, and
provider prices. Fast local queries also exposed PostgreSQL microsecond
timestamps being later than JavaScript's millisecond clock within the same
millisecond, leaving freshly inserted work unprocessed and one-shot mocks
unconsumed.

**How to apply:** create deterministic test-only configuration, and set due
timestamps explicitly in outcome-focused scheduler tests. Keep separate
scheduler-timing assertions rather than adding sleeps or changing runtime
rules to satisfy a fixture.
