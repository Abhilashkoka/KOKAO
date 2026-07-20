---
name: Sweep fail-ratio mass-outage alert e2e verification
description: How to reproduce and verify the sweep_fail_ratio superadmin banner in a real browser, and the drift pitfall that silently blocks it.
---

# Verifying the sweep_fail_ratio ("Mass connection outage suspected") alert

To force the alert cheaply in dev: set `SWEEP_CHECK_TIMEOUT_MS=1` and
`SWEEP_FAIL_RATIO_MIN_CHECKS=1` (development env), restart the API server, seed
one `connected_accounts` row for a superadmin tenant, then hit "Run now" on the
admin Connection Sweep card. Every check times out so the run crosses the 50%
ratio threshold. **Delete both env vars and restart afterwards** — a 1ms timeout
breaks all real dev sweeps.

**Drift pitfall:** the whole sweep-notification path (`notifySweepFailRatio` and
siblings) reads `notification_preferences`, which now has a `push` column. A dev
DB that predates that column makes the alert insert silently fail with
`column "push" does not exist` and NO banner appears. Fix = `pnpm --filter
@workspace/db run push`. **Why:** any change to `notificationPreferences` schema
must be pushed to dev before the notification dispatch path works at all.

**e2e false-positive to expect:** with the 1ms timeout, EVERY sweep alert type
fires each run (fail_streak, sweep_stalled, history_trimmed, fail_ratio). All
share the same banner component and "Reconnect now" link, so a browser tester
easily mistakes a `sweep_fail_streak` banner ("A connection keeps failing its
safety checks") for the mass-outage banner. Confirm suppression at the DB level:
after toggling in-app off for `sweep_fail_ratio`, new `sweep_fail_ratio` rows
have `in_app=false` — that is the real proof the toggle is respected, not the
on-screen presence of a different alert type.
