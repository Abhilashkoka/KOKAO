---
name: Guided Story pacing
description: Selected Guided Story runtime includes visual action and pauses, unlike narration-derived long-form runtime.
---

Treat a Guided Story's selected runtime as the visual story timeline, not a minimum speech target. Dialogue and narration must fit within it, but need not fill a fixed fraction of it.

**Why:** Cinematic action, reactions and pauses are meaningful parts of the story. Requiring speech to occupy a minimum fraction makes increasing the selected runtime reject otherwise valid dialogue and encourages filler.

**How to apply:** Preserve the speaking-rate upper bound and scene/timeline constraints. Timing repairs should preserve speech that already fits and use meaningful visual beats when extending a short timeline. Do not apply the narration-derived duration policy for long-form templates to Guided Story's user-selected runtime.

An explicit music-and-sound-effects-only brief is an intentional visual-only story, not incomplete model output. Do not repair it by inventing narration or reading stage directions aloud.

**Why:** Descriptive sentences can be mistaken for spoken copy; inserting them changes the requested soundtrack and may introduce unnecessary speech generation.

**How to apply:** Keep the visual timeline intact when removing speech. Preserve the no-voices requirement through script regeneration and provider-prompt compilation; allowing music must not also permit dialogue, voiceover or vocals.
