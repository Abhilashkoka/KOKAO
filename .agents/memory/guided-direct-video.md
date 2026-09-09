---
name: Guided direct video
description: Execution and compatibility rules for Guided Story jobs that bypass storyboard image rendering.
---

New Guided Story jobs go directly from completed script, cast, character/outfit/reference-sheet, and backdrop approvals to the explicitly selected native-audio model. They do not generate AI storyboard images, pause for storyboard review, synthesize narration, add subtitles, or add external music. Ordinary image-to-video providers use the approved primary character/outfit image as one opening-frame input. Atlas reference-to-video instead attaches every scene participant's approved character sheet then outfit, ordered by the scene's role list; prompt labels must use that exact order. Governed prompts carry environment, cast, camera motion, performance, continuity, timed dialogue, and native-audio direction.

Preserve authored multi-character dialogue scenes: one line has one designated owner, but every intended visible character remains in the scene with blocking, reactions, and eyelines. Do not post-process scripts into isolated single-speaker shots.

Cast size is story-decided, not selected or capped by the product UI. Historical setup role counts are compatibility data only and never constrain generation; estimates and casting use the actual canonical script roles. A generous validator bound may reject runaway malformed model output, but must not be presented as a creative limit.

Legacy marker-absent jobs retain their storyboard preview, approval, and recovery path. Never infer direct mode from missing preview data; use an immutable versioned execution marker.

**Why:** Reinterpreting historical rows would break paid preview recovery, while sending only the backdrop or an unused narration track would defeat character approval and create unnecessary provider work.

**How to apply:** Any Guided enqueue, retry, clone, funding calculation, UI review control, or composition change must branch on the exact execution marker. Direct native-audio composition accepts an explicit scene timeline without narration cues and preserves provider audio.