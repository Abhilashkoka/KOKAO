---
name: Reply-chain resend (Threads/X/LinkedIn)
description: Pattern for resuming partially failed multi-post publishes across platforms
---

Mid-chain failure on a multi-post publish (LinkedIn comments, Threads reply chain, X thread) must NOT fail the whole publish once the anchor post landed. Pattern:

- Persist a resumable snapshot on the content item (`threadsChainState`/`twitterChainState`, shared `ThreadChainState { firstPostId, lastPostedId, posts, postedCount }`) with the EXACT chunk texts — a later caption edit can't change what a resend posts.
- Publish response returns 200 + `publishWarning`; item still marked published.
- Dedicated resend endpoint (`/content/:id/resend-{threads,twitter}-posts`) posts only `posts[postedCount..]`, chained onto `lastPostedId`, dedupe-probes recent posts first (reuse an exact-text match within 10 min), and clears the state when complete.
- Serializer exposes `threadsPostsPending`/`twitterPostsPending`; library card shows an amber warning + "Resend posts" button.
- First-post failure still throws = full publish failure (nothing to resume).

**Why:** platforms have no idempotency keys; naive full-retry double-posts the already-landed pieces.
**How to apply:** any new platform with chained multi-post publishing should follow this same state/resend/dedupe contract; integration tests live in `chainResend.test.ts`-style route tests with mocked fetch.
