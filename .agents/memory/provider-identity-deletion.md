---
name: Provider-backed identity deletion
description: Race and cleanup invariants when deleting identity-verification records backed by provider assets.
---

Allow users to delete pending identity-verification records, but assume deletion can win after a callback has started provider work. A successful callback finalizer must verify that its local terminal write persisted; if the row vanished, it must compensate by deleting the newly resolved upstream asset.

**Why:** The callback may claim a pending row, contact the provider outside the database transaction, and finish after the user deletes the record. Treating an unmatched terminal update as success leaks the provider asset and reports a false success.

Cleanup identity must be scoped to a verification attempt, not only the local identity. Retrying the same identity may leave an older provider session that still needs independent cleanup. Persist provider recovery handles encrypted before returning a verification URL, atomically hand any retained handle to cleanup before delete or retry, and never discard an unresolved handle merely because automatic retries are exhausted or unsupported.

Cleanup workers need per-claim lease tokens. A stale worker may resume after another process reclaimed the row; terminal and retry writes must compare the exact lease token so the stale worker cannot overwrite the new owner.

**Why:** Provider work crosses database and process-crash boundaries. Identity deletion, callback completion, and retry can race, while provider responses can arrive after local state moved on.

**How to apply:** Check affected rows on every post-provider finalization, tenant-scope terminal writes, create attempt-scoped durable cleanup before discarding local recovery state, encrypt retained provider handles, fence every worker write by claim token, and bound provider response-body consumption as well as response headers.