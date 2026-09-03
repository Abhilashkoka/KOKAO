---
name: Privacy-safe video recovery
description: Safety and accounting rules for recovering generated storyboard images rejected as possible real people.
---

Only the exact provider input-image privacy policy code may trigger automatic recovery. Live provider parsing may understand several structured response shapes, but historical recovery authorization must use a separate strict parser: accept only known persisted OpenRouter wrappers whose immediate structured `error.code` exactly matches. Never authorize from message text, code-like prefixes, or unrelated nested fields. Generated story-animation scenes may replace one keyframe once; saved-character references and user-uploaded identity images must never be silently transformed.

**Why:** Policy rejections must not be treated as transient outages or bypassed, while conservative false positives on newly generated fictional B-roll should not discard narration and unrelated completed scenes.

**How to apply:** Persist the attempt before the replacement provider call, reserve one additional unit through the original job's funding rail, retain every prior receipt, retry only the dependent animation, and fail closed if the replacement is rejected or recovery state is incomplete after restart. Serialize retry creation and storyboard edits; intentionally editing the affected scene invalidates stale eligibility without counting it as an added scene.

OpenRouter submit/poll failures must be parsed from a bounded full response body before producing the short log/error detail. Truncating nested JSON first can hide the exact privacy code and misclassify the rejection as a generic provider failure.

**Why:** OpenRouter can wrap the upstream policy object as JSON inside an outer JSON message; the code may appear beyond the logging limit, and truncated JSON cannot be parsed safely.

**How to apply:** Read at most a conservative bounded body, run strict structured parsing on that bounded full value, then truncate only the non-sensitive detail used in generic errors and logs.