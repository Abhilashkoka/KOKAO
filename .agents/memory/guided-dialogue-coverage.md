---
name: Guided dialogue coverage
description: Rules for converting multi-role Guided Story scenes into reviewable, lip-syncable shots.
---

Expand generated Guided Story scripts into coverage before the user reviews or approves them. Preserve every line's identity, ownership, text, and timing; split only the scene framing so each speaking shot contains exactly its active speaker.

Keep unchanged scenes byte-identical. Derive split scene IDs deterministically, hold eyelines across the original scene, avoid sub-1.2-second cuts, preserve location/lighting continuity, and never exceed the script validator's scene ceiling.

**Why:** Lip-sync models cannot reliably choose a speaker when several faces share a frame. Expanding after approval would invalidate immutable script, backdrop, preview, funding, and cast-approval bindings.

**How to apply:** Run coverage immediately after script validation/repair becomes canonical. Treat each resulting shot as the existing one-scene/one-storyboard unit; never rewrite or retime dialogue to obtain coverage.