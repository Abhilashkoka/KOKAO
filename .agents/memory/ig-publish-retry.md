---
name: Instagram publish retry classification
description: How transient vs definitive Instagram publish failures are classified for the bounded auto-retry.
---

Container creation uses a longer bounded timeout than generic social calls, and creation timeouts may retry; they cannot publish a post. Do not extend this rule to media_publish.

**Why:** A production Instagram publish stopped on the generic six-second deadline during container creation, before any publish request. The generic fail-fast timeout rule exists for synchronous shutdown draining, but Instagram preparation runs as a background job.

**How to apply:** Keep preparation retries bounded and keep final-write timeout handling conservative; a lost media_publish response is ambiguous and must not trigger a blind repost.


# Instagram publish auto-retry

The background Instagram publish flow (`routes/meta.ts` `runInstagramPublish`) wraps a single-attempt `attemptInstagramPublish` in a bounded retry loop (`IG_PUBLISH_RETRY`, exported/mutable so tests can shrink it). Only transient failures are retried with exponential backoff; the item flips to "failed" only after retries are exhausted or on a definitive error.

Classification (via `InstagramPublishError { retryable }` + `isRetryableStatus`):
- Retryable: HTTP 429 or any 5xx from the Graph API (create/publish/status-poll); container still `IN_PROGRESS` past the poll cap; any UNCLASSIFIED thrown error (network/storage blip) — unknown defaults to retryable since the loop is bounded.
- Non-retryable (fail fast): any 4xx (revoked/invalid token, bad request); container status `ERROR`/`EXPIRED` (bad/unsupported image — retrying the same image keeps failing).

**Why:** many IG failures are transient (brief 5xx, rate-limit blip, image still processing), so a one-shot "failed" forced users to manually re-publish. Retrying definitive errors just wastes the budget and delays the visible failure.

Scheduled posts have a parallel mechanism: the scheduled publisher re-queues (pending + delayed scheduledAt + `retryCount` bump, no notification) any core outcome with errorStatus 503 up to `SCHEDULED_TRANSIENT_RETRY.maxRetries`; cores signal "transient" by returning 503 (X token-refresh outage does today). User-initiated schedule retries fail immediately — no silent re-queue while a user is waiting.

**How to apply:** if extending the same "wait until ready" / retry safety to Facebook photo posts, reuse this transient-vs-definitive split (5xx/429/still-processing = retry; 4xx/bad-media = fail fast). Test gotcha: the "Instagram container readiness" poll-cap tests must pin `IG_PUBLISH_RETRY.maxAttempts = 1`, otherwise the now-retryable IN_PROGRESS timeout multiplies the poll count (attempts × retries) and slows the suite.
