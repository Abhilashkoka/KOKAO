---
name: Video cover selection
description: Cross-module rules for selecting, generating, and persisting finished-video cover images.
---

Every completed Video Studio engine must offer the same cover workflow: free extracted-frame candidates on open, tenant-owned uploads, and purpose-made generated options only after an explicit user request. Character videos anchor generated covers to their frozen identity/outfit reference; other modules derive them from the finished video's topic and first scene without inventing a presenter.

The selected cover is the canonical video thumbnail and must also update an already-saved library item's thumbnail. Candidate generation is additive and path-deduplicated so tiles do not reorder beneath the user.

**Why:** A fixed frame at one second gave users no control and often produced weak or blurred thumbnails. Restricting purpose-made covers to character videos would also make the same completed-video action inconsistent across Video Studio modules.

**How to apply:** Keep extraction, upload, generation, and selection behind tenant ownership checks and successful-video status. Preserve explicit-request semantics for generated options, server-owned capability reporting, aspect-specific composition, and character reference requirements when a locked character exists.