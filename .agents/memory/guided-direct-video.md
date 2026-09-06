---
name: Guided direct video
description: Execution and compatibility rules for Guided Story jobs that bypass storyboard image rendering.
---

New Guided Story jobs go directly from completed script, cast, character/outfit/reference-sheet, and backdrop approvals to the explicitly selected Higgsfield native-audio model. They do not generate AI storyboard images, pause for storyboard review, synthesize narration, add subtitles, or add external music. Each scene uses the approved primary character/outfit image as the single provider opening-frame input; governed prompts carry environment, secondary cast, camera motion, performance, continuity, timed dialogue, and native-audio direction.

Legacy marker-absent jobs retain their storyboard preview, approval, and recovery path. Never infer direct mode from missing preview data; use an immutable versioned execution marker.

**Why:** Reinterpreting historical rows would break paid preview recovery, while sending only the backdrop or an unused narration track would defeat character approval and create unnecessary provider work.

**How to apply:** Any Guided enqueue, retry, clone, funding calculation, UI review control, or composition change must branch on the exact execution marker. Direct native-audio composition accepts an explicit scene timeline without narration cues and preserves provider audio.