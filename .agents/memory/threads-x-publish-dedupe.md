---
name: Threads/X/LinkedIn publish duplicate-post guard
description: Pre-publish probe of recent posts so a retried Threads, X, or LinkedIn publish never double-posts.
---

**Rule:** Threads, X, and LinkedIn have no idempotency key for post creation, so every publish probes the account's recent posts first (X: GET `/2/users/{id}/tweets?tweet.fields=created_at`; Threads: GET `/{userId}/threads?fields=id,text,timestamp`; LinkedIn: GET `/rest/posts?author={urn}&q=author` paged via `start`/`count`) and short-circuits any chunk whose exact text already landed within a 10-minute dedupe window, reusing the existing post id. LinkedIn matches on the ESCAPED "Little Text" commentary (what was actually sent), and on a dedupe hit it also resumes overflow comments from the persisted `linkedinCommentState`/published-postId instead of re-posting them.

**Why:** A publish can commit but return a transient-looking error; the user re-clicking (or a future auto-retry) would double-post — on Threads a whole reply chain can duplicate.

**How to apply:** Unlike Facebook (probe only after a transient failure inside the retry helper), these routes have no in-request retry, so the probe runs up-front on every publish. Matching is per-chunk and consuming (a matched post is removed from the candidate list), the reply chain resumes from a matched first post, and image upload/signed-URL minting is skipped when the first post already landed. Probe failure is best-effort → publish proceeds normally. All three probes paginate under an exported mutable `*_DEDUPE_PROBE` {pageSize, maxPages} config so busy accounts can't scroll a landed post past page 1. LinkedIn's probe has NO time-based early stop: its API sorts by LAST_MODIFIED (not createdAt), so a page of old-but-recently-edited posts says nothing about later pages — the page cap is the only bound. Window guard means identical intentional re-posts >10 min apart still publish.
