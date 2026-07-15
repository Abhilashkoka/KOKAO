---
name: Background dead-connection sweep
description: Periodic in-process sweep that re-verifies all tenants' social connections; how it stays safe and where LinkedIn reverify lives now.
---

# Background dead-connection sweep

A periodic in-process sweep (`lib/connectionSweep.ts`, started from `index.ts`,
15-min interval, 60s initial delay, unref'd timers, overlap guard, stopped on
SIGTERM/SIGINT) re-verifies every tenant's facebook/instagram/linkedin/twitter/
threads/youtube connections with `force=false`.

**Why:** users who never open the Accounts page must still get the deduped
breakage notification + email. The shared `REVERIFY_STALE_MS` gate is the rate
limiter — the sweep MUST NOT pass `force: true` or it will hammer provider APIs
every cycle.

**How to apply:**
- LinkedIn reverify was moved from `routes/linkedin.ts` into
  `lib/socialReverify.ts` (`reverifyLinkedin(tenantId, {force?})`) so both the
  route and the sweep share it; don't re-add a route-local copy.
- `reverifyLinkedin` also flips a timestamp-expired but still-"verified" row to
  failed (and notifies) without a live call — parity for sweep users.
- Facebook is re-checked before Instagram per tenant (IG rides the FB token).
- Each tenant+platform check is individually try/caught; one failure never
  aborts the sweep.
- `reverifyThreads`/`reverifyYoutube` live in `lib/socialReverify.ts` too:
  Threads flips timestamp-expired tokens without a live call, REFRESHES the
  rolling long-lived token when inside the 7-day renewal window (so inactive
  users' tokens never lapse), otherwise probes /me; YouTube's aliveness test IS
  a refresh-token exchange against Google (invalid_grant = dead). The route
  files (`routes/threads.ts`, `routes/youtube.ts`) still carry their own copies
  of the refresh logic — keep behavior in sync if either changes.
