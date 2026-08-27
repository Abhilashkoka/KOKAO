---
name: Hybrid video accounting
description: Funding and recovery rules for mixed character lip-sync and story-animation videos.
---

Treat a hybrid video as one immutable narrated timeline with typed beats. Speaking beats own identity-keyframe, source-plate, and lip-sync operations; animation beats own keyframe and animation operations. Persist every acknowledged provider receipt before advancing so recovery can reuse completed work exactly once.

**Why:** Hybrid retries cross several provider and wallet ownership boundaries. Counting only final clips underfunds the first attempt, while counting independently settled cloned narration inside the video hold double-charges it.

**How to apply:** Use one shared exact-unit calculation across quote, post-plan funding, recovery, settlement, and refund. Built-in/unmetered narration consumes one product unit but no invented provider cost; cloned narration remains independently settled and contributes no video unit once its accounting mode is known.