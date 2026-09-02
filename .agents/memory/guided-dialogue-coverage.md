---
name: Guided dialogue coverage
description: Rules for converting multi-role Guided Story scenes into reviewable, lip-syncable shots.
---

Expand generated Guided Story scripts into coverage before the user reviews or approves them. Preserve every line's identity, ownership, text, and timing; split only the scene framing so each speaking shot contains exactly its active speaker.

Every newly generated script starts with a 3–5 second narrated ensemble build-up at 0ms. It includes all opening-hook characters in one frame, gives them concrete hook-relevant actions or expressions, and visibly settles before dialogue coverage begins. Validate this contract and give timing repairs one chance to restore it.

Keep unchanged scenes byte-identical. Derive split scene IDs deterministically, hold eyelines across the original scene, avoid sub-1.2-second cuts, preserve location/lighting continuity, and never exceed the script validator's scene ceiling.

For single-speaker shots, strip authored multi-person staging rather than appending a conflicting framing instruction. Lead with one-person/one-face constraints, prohibit mirrors/reflections, keep the mouth unobstructed and the turn mostly front-facing, then include only setting clauses. Preserve authored staging for group shots.

**Why:** The opening needs a visual hook before close dialogue coverage starts. After that beat, lip-sync models cannot reliably choose a speaker when several faces share a frame. Concrete two-person or mirror staging overrides a later “single speaker” note and can repeatedly crash face tracking. Expanding after approval would invalidate immutable script, backdrop, preview, funding, and cast-approval bindings.

**How to apply:** Run coverage immediately after script validation/repair becomes canonical. Treat each resulting shot as the existing one-scene/one-storyboard unit; never rewrite or retime dialogue to obtain coverage.