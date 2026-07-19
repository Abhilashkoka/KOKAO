---
name: Sweep tests must stub every reverifier family
description: Tests that run the real connection sweep against the shared dev DB must mock ALL reverifier modules (social + ads), or leftover rows cause flaky cross-file failures.
---

Tests that call `sweepDeadConnections()` sweep the ENTIRE shared dev database, not just the test's own tenant. Any leftover verified rows from other test files get re-verified with real network calls.

**Why:** After the sweep gained ad-account coverage, `connectionSweep.timeout.test.ts` (which mocked only `./socialReverify`) failed intermittently in full-suite runs: leftover `ad_account_connections` rows hit the real Meta Ads API, timed out under the test's tiny per-check cap, and overwrote `lastError` with a `meta_ads` entry the assertion didn't expect. Failures never reproduced in isolation — only with other files' leftovers present.

**How to apply:**
- Any test running the real sweep must mock every reverifier module the sweep dispatches to — currently `./socialReverify` AND `./adsReverify`. When a new platform family is added to the sweep, update these mocks too.
- A full-module `vi.mock("./socialReverify", ...)` must also export `REVERIFY_STALE_MS` (adsReverify imports it from there); prefer the `importOriginal` partial-mock pattern to keep constants real.
- Assert on the test tenant's rows/behavior, never on exact sweep totals — the shared DB adds noise.
- The shared `deleteTenant` test helper must delete from every tenant-scoped connections table (`connected_accounts` AND `ad_account_connections`); orphaned rows accumulate across runs and each one costs the real sweep a network timeout.
- Full-suite `pnpm run test` also has unrelated run-to-run flakiness from shared-DB leftovers; re-run and check whether the failure moves before assuming your change caused it — but if the SAME test fails twice, it's real.
