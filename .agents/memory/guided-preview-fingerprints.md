---
name: Guided preview fingerprints
description: Compatibility rule for immutable Guided scene validation after PostgreSQL jsonb round trips.
---

Do not recompute or compare Guided scene fingerprints from order-sensitive JSON after a PostgreSQL jsonb round trip. Preserve the stored fingerprint, require it to remain present, and structurally compare every immutable source field while ignoring object-key order.

**Why:** PostgreSQL jsonb reorders nested object keys. Older fingerprints were hashed from JavaScript insertion order, so semantically identical saved cast/storyboard inputs can produce a different recomputed hash and strand valid review jobs.

Cast approval is a separate immutable boundary: bind approval to the current draft revision, exact server-resolved reference paths, and SHA-256 hashes of the stored character and outfit bytes. Re-hash provider-bound bytes before preview dispatch; never trust client-supplied hashes or mutable live character records.

**Why:** A matching path alone does not prove that the reviewed image bytes are still the bytes sent to a provider, while an approval detached from draft revision can silently survive a cast edit.

**How to apply:** Any Guided preview, approval, retry, or recovery path that validates a persisted board against its immutable snapshot must compare source fields structurally and leave the original fingerprint byte-for-byte unchanged. Preview, correction, retry, and final paths must fail closed unless the complete revision-bound cast approval manifest travels with the immutable job snapshot.