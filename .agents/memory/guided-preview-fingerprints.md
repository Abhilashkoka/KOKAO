---
name: Guided preview fingerprints
description: Compatibility rule for immutable Guided scene validation after PostgreSQL jsonb round trips.
---

Do not recompute or compare Guided scene fingerprints from order-sensitive JSON after a PostgreSQL jsonb round trip. Preserve the stored fingerprint, require it to remain present, and structurally compare every immutable source field while ignoring object-key order.

**Why:** PostgreSQL jsonb reorders nested object keys. Older fingerprints were hashed from JavaScript insertion order, so semantically identical saved cast/storyboard inputs can produce a different recomputed hash and strand valid review jobs.

**How to apply:** Any Guided preview, approval, retry, or recovery path that validates a persisted board against its immutable snapshot must compare source fields structurally and leave the original fingerprint byte-for-byte unchanged.