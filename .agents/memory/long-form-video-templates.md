---
name: Long-form video templates
description: Safety and accounting rules for script-derived video templates up to ten minutes.
---

Long-form template duration is derived from the voiced script and capped only at complete narration-cue boundaries. Never trim PCM at an arbitrary timestamp or leave captions describing removed speech.

**Why:** A numeric form limit alone does not make long video generation safe. Longer jobs multiply scene-level provider work, and arbitrary audio trimming produces broken speech and caption drift.

**How to apply:** Validate that maximum duration is feasible within scene-duration and scene-count bounds. Native templates fund one planning slice, persist the exact script/timing/scene plan, then atomically acquire only the planned visual units before paid previews or renders. Keep every added-scene hold and provider attempt durably linked to the job, and resume from checkpoints without replanning. Finite-quota jobs keep the existing ceiling reservation until quota holds can provide the same durability. Preserve legacy short-template behavior unless a template opts into native long-form settings.