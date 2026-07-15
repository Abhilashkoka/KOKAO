---
name: Platform fetch timeouts
description: All outbound social-platform HTTP calls must use the bounded-timeout platformFetch helper
---

Rule: every outbound social-platform HTTP call in the API server (publish routes, reverify, token exchanges) goes through the `platformFetch` helper (AbortSignal-based timeout, default well below the 10s shutdown drain cap) instead of raw `fetch`.

**Why:** sync publish requests are drained during graceful shutdown; a single hung platform call with no timeout burns the entire drain window on every restart and leaves the publish with an ambiguous cutoff instead of a persisted "failed" status.

**How to apply:** when adding a new platform integration or route, import the helper rather than calling `fetch` directly. Treat its timeout error as terminal (non-retryable) in retry loops — retrying a hang defeats the bound. Caller-supplied AbortSignals combine with the timeout; a caller abort must not be reported as a timeout.
