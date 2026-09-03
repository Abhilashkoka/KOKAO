---
name: Character reference sheets
description: Approval and runtime rules for multi-view identity sheets on tenant characters.
---

Every tenant-created character, whether prompted or uploaded from a real photo, keeps its canonical portrait and receives a separately billed multi-view reference sheet generated through reference-capable image routing. The sheet is never auto-approved.

**Why:** A multi-view grid is valuable for human identity review but is a poor sole runtime reference for providers that expect one subject image. Real-photo and AI-created identities need the same explicit consent boundary before new videos use them.

**How to apply:** Generate the sheet from the canonical portrait, preserve that portrait and outfit paths, revoke approval before regeneration, and fail closed at every new video/cast enqueue until the current sheet is approved. Existing immutable job snapshots and recovery paths remain usable.