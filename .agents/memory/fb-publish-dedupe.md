---
name: Facebook publish duplicate-post guard
description: Retry idempotency for Facebook Page publishing — probe recent posts before retrying a transient failure.
---

**Rule:** The Graph API has no idempotency key for Page posts, so any retry of a transient publish failure must first probe whether the previous attempt actually landed (GET `/{pageId}/posts?fields=id,message,created_time`, match exact message + created_time >= publish start minus a 60s skew buffer) and short-circuit with the existing post id.

**Why:** A "transient" 5xx/`is_transient` error can arrive AFTER Meta committed the write; blind retry double-posts on the user's Page.

**How to apply:** The probe hook lives in the Facebook retry helper (`postToGraphWithRetry` `checkAlreadyPosted` param in `routes/meta.ts`); it runs after every transient failure, including before the final throw. Probe failures are swallowed (best-effort → fall back to retry). Empty message skips the probe. Any new retried Page write should reuse this hook rather than retrying blindly.
