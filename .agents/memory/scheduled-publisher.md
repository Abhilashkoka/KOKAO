---
name: Scheduled publisher executor
description: Invariants for the in-process scheduled-post auto-publish loop
---
The scheduled publisher (connectionSweep-style in-process loop) auto-publishes due `scheduled_posts` via the shared per-platform publish cores.

Rules that must hold:
- **Claim atomically**: pending→processing via a single UPDATE ... RETURNING; never SELECT-then-UPDATE.
- **Same lock as manual publish**: acquire the per-item resend lock before driving a core; if held, revert the row to pending and let the next tick retry. This is the manual-vs-scheduled double-post guard.
- **Status-guard every terminal write**: final published/failed updates must be `WHERE id AND status='processing'` and skip notification when 0 rows update. **Why:** a user can cancel/delete mid-flight; an unguarded write resurrects a cancelled schedule and sends a bogus notification.
- **Stuck 'processing' rows are failed after a timeout, never re-driven** — the platform write may already have landed; re-driving risks duplicates.
- Cores own content-item status; the scheduler only owns the schedule row (contract in `publishOutcome.ts`).
- Scheduled publishes are NOT metered (no usage events); metering happened when content was created.
- **Transient vs definitive outcomes**: all publish cores classify passing platform outages (5xx/429 exhaustion, transient token-refresh outages) as errorStatus 503 — the only status the executor's bounded auto-retry re-queues. Definitive failures (revoked tokens, bad content, timeouts) stay 400/502 and fail immediately. **Why:** a transient outage marked 502 permanently fails a scheduled post the next tick could have published. Refresh-outage 503 gates require the row still `verifyStatus === "verified"` — a definitive refresh rejection flips the row to failed first, so failed/unverified rows keep the 400 reconnect path.

**How to apply:** any new dispatch path (retry button, bulk re-run, new platform) must reuse the claim + lock + guarded-finish pattern, not re-implement it.
