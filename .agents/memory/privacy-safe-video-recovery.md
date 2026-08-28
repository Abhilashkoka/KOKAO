---
name: Privacy-safe video recovery
description: Safety and accounting rules for recovering generated storyboard images rejected as possible real people.
---

Only the exact provider input-image privacy policy code may trigger automatic recovery. Generated story-animation scenes may replace one keyframe once; saved-character references and user-uploaded identity images must never be silently transformed.

**Why:** Policy rejections must not be treated as transient outages or bypassed, while conservative false positives on newly generated fictional B-roll should not discard narration and unrelated completed scenes.

**How to apply:** Persist the attempt before the replacement provider call, reserve one additional unit first, retain every prior receipt, retry only the dependent animation, and fail closed if the replacement is rejected or recovery state is incomplete after restart. Serialize recovery-capable scene animation so incremental funding snapshots cannot race.