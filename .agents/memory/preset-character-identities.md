---
name: Preset character identities
description: Ownership, snapshot, and compatibility rules for the centrally managed fictional cast.
---

Global preset identities are platform-owned and revisioned; administrators may change future availability, order, and metadata, but tenant-funded outfit derivatives always remain tenant-owned and never mutate the global identity. Every queued job freezes the exact identity reference, approved outfit, licensed stock voice, language, and preset revision it will use.

**Why:** Mutable catalog reads during retries can change a character's face, wardrobe, or voice after approval, while treating an outfit variation as a new character loses the stable fictional identity and weakens tenant isolation.

**How to apply:** Resolve and authorize presets and approved derivatives before funding; validate language against both the preset and selected voice; classify any resolved cast as image-anchored for model preflight; consume only the immutable job snapshot in workers and fail closed when its identity reference is unavailable.