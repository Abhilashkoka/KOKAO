---
name: Guided preview fingerprints
description: Compatibility rule for immutable Guided scene validation after PostgreSQL jsonb round trips.
---

Do not recompute or compare Guided scene fingerprints from order-sensitive JSON after a PostgreSQL jsonb round trip. Preserve the stored fingerprint, require it to remain present, and structurally compare every immutable source field while ignoring object-key order.

**Why:** PostgreSQL jsonb reorders nested object keys. Older fingerprints were hashed from JavaScript insertion order, so semantically identical saved cast/storyboard inputs can produce a different recomputed hash and strand valid review jobs.

Cast approval is a separate immutable boundary: bind approval to the current draft revision, exact server-resolved reference paths, and SHA-256 hashes of the stored character and outfit bytes. Re-hash provider-bound bytes before preview dispatch; never trust client-supplied hashes or mutable live character records.

**Why:** A matching path alone does not prove that the reviewed image bytes are still the bytes sent to a provider, while an approval detached from draft revision can silently survive a cast edit.

**How to apply:** Any Guided preview, approval, retry, or recovery path that validates a persisted board against its immutable snapshot must compare source fields structurally and leave the original fingerprint byte-for-byte unchanged. Preview, correction, retry, and final paths must fail closed unless the complete revision-bound cast approval manifest travels with the immutable job snapshot.

An approved default backdrop covers every scene unless that scene has its own independently approved override. Preview generation must load each scene's effective approved backdrop bytes into the same compact reference sheet as the approved character/outfit bytes, and must require a reference-capable provider; prompt-only fallback is forbidden.

**Why:** Freezing paths in a job snapshot does not create visual consistency if the provider never receives those images, or if a provider pin silently strips image input.

**How to apply:** Replacing the default invalidates only inheriting scene previews; replacing an override invalidates only its scene. Enqueue, preview, correction, retry, and final-render gates revalidate each effective backdrop, including its stored-byte SHA when available, before reservation or provider dispatch. Final image-to-video work uses the already approved preview still, but still re-hashes the source backdrop bytes immediately before dispatch so mutable storage cannot bypass approval.

Guided previews use the most recent completed prior shot for each role as supplementary continuity guidance. Approved identity, outfit, and backdrop tiles remain first and authoritative; prior shots may guide face, hair, clothing presentation, lighting, and style, but never replace approved assets or override the current pose, expression, framing, or action.

**Why:** Independent generations drift, while chaining generated images without permanent approved anchors compounds small identity and wardrobe errors. Alternating dialogue also makes the immediately previous shot the wrong character reference.

**How to apply:** Track the latest completed image per role. For each new, resumed, corrected, or manually rerolled Guided shot, pass only prior images associated with that shot's cast. Update role continuity only after the image is durably accepted; never use failed, uncertain, current, or later shots.

Narration reuse is independent from visual-scene reuse. Character, outfit, or backdrop changes invalidate affected previews and render receipts, but preserve narration whenever transcript text, timing, line ownership, and role voice bindings are unchanged.

**Why:** Tying narration reuse to the full visual fingerprint discarded valid paid audio after a cast-reference replacement and made final approval fail before rendering.

**How to apply:** Storyboard rebuilds compare only audio-affecting inputs before retaining narration. Recovery of a legacy board with missing narration must regenerate from its immutable script and voices before rendering. A legacy retry with no model snapshot must resolve and freeze the configured model before funding; the renderer must never infer mutable defaults.