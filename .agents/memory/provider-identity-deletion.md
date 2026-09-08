---
name: Provider-backed identity deletion
description: Race and cleanup invariants when deleting identity-verification records backed by provider assets.
---

Allow users to delete pending identity-verification records, but assume deletion can win after a callback has started provider work. A successful callback finalizer must verify that its local terminal write persisted; if the row vanished, it must compensate by deleting the newly resolved upstream asset.

**Why:** The callback may claim a pending row, contact the provider outside the database transaction, and finish after the user deletes the record. Treating an unmatched terminal update as success leaks the provider asset and reports a false success.

**How to apply:** Check affected rows on every post-provider finalization, tenant-scope the terminal write, compensate any newly created/resolved provider resource when persistence loses the race, and catch the entire fire-and-forget cleanup chain including credential resolution.