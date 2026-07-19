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

**How to apply:** any new dispatch path (retry button, bulk re-run, new platform) must reuse the claim + lock + guarded-finish pattern, not re-implement it.
