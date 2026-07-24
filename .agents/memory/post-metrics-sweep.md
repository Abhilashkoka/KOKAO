---
name: Post metrics sweep
description: Per-post metrics ingestion (FB/IG/LinkedIn) — polling decay, claiming, failure classification.
---

# Post metrics sweep

- Metrics rows are seeded from `publishedPlatforms` (one row per contentItemId+platform, onConflictDoNothing) and polled on a decay schedule: hourly for the first 48h, daily until 14 days, then done.
- **Claiming rule:** `pollDueMetrics` must claim rows atomically before any platform call — a single `UPDATE ... RETURNING` over a `FOR UPDATE SKIP LOCKED` subselect that pushes `nextPollAt` one hot interval forward. The pushed timestamp doubles as the transient-failure backoff; success/definitive-failure paths overwrite it.
  - **Why:** a plain select-then-process loop lets concurrent instances or overlapping ticks poll the same row twice (duplicate platform calls, races). Caught in architect review.
- Failure classification: 5xx/429/network/timeout = transient (backoff, keep counters); other 4xx = definitive (`pollState=failed`, never retried). LinkedIn expired-access-token is treated transient (the connection sweep refreshes it).
- Frontend gating: every page consuming `/metrics/summary` (calendar, library) must gate the hook with `enabled: flags.postMetrics` — the calendar flag alone is not enough, since metrics can be killed independently.
- Sweep tests mock `METRICS_FETCHERS` via `vi.mock("./postMetrics")` with `importActual` spread; seed rows with fake negative contentItemId (no FK on the column).
