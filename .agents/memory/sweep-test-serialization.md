---
name: Sweep-suite serialization lock
description: Why the sweep-running api-server test suites hold a pg advisory lock for their lifetime.
---
The three suites that run the REAL connection sweep (connectionSweep.test.ts, connectionSweep.timeout.test.ts, adsReverify.test.ts) each acquire a session-scoped Postgres advisory lock (acquireSweepTestLock in src/test/dbHelpers.ts) in beforeAll and release it in afterAll.

**Why:** the sweep walks EVERY tenant's connections in the shared dev DB; parallel vitest workers running two sweep suites at once re-verify each other's seeded dead rows ("expected failed, got verified") and inflate mock call counts. This flaked full validation runs repeatedly while each suite passed in isolation.

**How to apply:** any new suite that calls sweepDeadConnections/triggerSweepNow against the real DB must take the same lock (and give beforeAll a long timeout, e.g. 600s, since it may wait behind the ~2min connectionSweep suite).

Also: sweep suites must never assert exact global reverify call counts (foreign stale rows from other suites' shared-DB seeding inflate them) — filter mock calls by this test's credentials. And they pin testTimeout: 120s, since full-run DB load makes individual sweep tests exceed the 30s default.
