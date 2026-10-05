---
name: Long native video scenes
description: User intent for model-aware continuous scenes in Video Studio.
---

The user wants Video Studio to use the complete capabilities of selected video models such as Wan and Seedance, building scenes up to 30 seconds long with dialogue, voice, lip-sync, and consistency where supported.

**Why:** The user wants longer continuous scenes rather than unnecessarily fragmented short clips.

**How to apply:** Verify each exact model/provider's duration and audio/reference capabilities; do not assume all Wan or Seedance variants support 30 seconds. Preserve this goal when designing scene planning.

Model-generated voices are the default. When a person's brand image is used, ask whether their Brand Kit voice should be used and let the user confirm the per-character mapping.

**Why:** The user explicitly selected native audio by default and requested person-specific Brand Kit voice mapping; an image alone is not permission to infer or assign a voice.

**How to apply:** Do not silently discard a selected cloned voice when enabling native audio. Explain separate speech/lip-sync requirements and reject unsupported multi-person exact-voice shots before funding.
