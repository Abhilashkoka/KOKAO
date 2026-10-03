---
name: Guided direct video
description: Execution and compatibility rules for Guided Story jobs that bypass storyboard image rendering.
---

New Guided Story jobs go directly from completed script, cast, character/outfit/reference-sheet, and backdrop approvals to the selected model. They do not generate AI storyboard images or pause for storyboard review. English may use provider-native synchronized audio; Telugu, Hindi, and Tamil must disable provider speech and compose KOKAO's frozen-locale narration because native-audio capability is not a language guarantee. Ordinary image-to-video providers use the approved primary character/outfit image as one opening-frame input. Atlas reference-to-video instead attaches every scene participant's approved character sheet then outfit, ordered by the scene's role list; prompt labels must use that exact order.

Preserve authored multi-character dialogue scenes: one line has one designated owner, but every intended visible character remains in the scene with blocking, reactions, and eyelines. Do not post-process scripts into isolated single-speaker shots.

Cast size is story-decided, not selected or capped by the product UI. Historical setup role counts are compatibility data only and never constrain generation; estimates and casting use the actual canonical script roles. A generous validator bound may reject runaway malformed model output, but must not be presented as a creative limit.

Legacy marker-absent jobs retain their storyboard preview, approval, and recovery path. Never infer direct mode from missing preview data; use an immutable versioned execution marker.

Character-free scenes (end cards, product shots, scenery) may legitimately have an empty participating-role list. Atlas reference rendering must still attach the frozen approved backdrop, without inventing a cast member.

**Why:** A narrated logo end card failed despite having approved backdrop data because the renderer treated an empty cast as missing metadata.

**How to apply:** Distinguish absent scene metadata from an intentionally empty role list; retain all approvals for nonempty cast and the mandatory backdrop checks. Runner tests with empty casts may enter preview generation, so use the existing preview mock rather than fake image bytes in Sharp.

**Why:** Reinterpreting historical rows would break paid preview recovery. Seedance can accept exact Telugu dialogue instructions yet generate speech in another language, so provider-native capability cannot override the immutable story locale.

**How to apply:** Any Guided enqueue, retry, clone, funding calculation, UI review control, or composition change must branch on the exact execution marker and frozen locale. Native audio is English-only; localized jobs freeze `generateAudio:false`, synthesize approved-language narration, and keep eligible intrinsic lip-sync planning.

Character-free staging does not imply character-free embedded media: an end card can request a still from the preceding reel while listing no visible cast.

**Why:** Production output retained the approved doctor in earlier footage but invented a different doctor inside the final reel thumbnail when the end card received only a backdrop reference.

**How to apply:** When diagnosing consistency, inspect embedded screens/thumbnails and their reference dependencies separately from on-screen cast. A reliable correction should reuse actual preceding footage for a requested reel still, rather than ask a cast-free generation to invent it.

Freeze explicit finished-reel reuse decisions at new enqueue, after brand-ending replacement. Do not infer them on historical recovery. Native scene audio remains useful even when the corresponding model-generated preview pixels are replaced; externally narrated local replays need no target video-provider call.

**Why:** Reusing complete raw checkpoints must not restore invented thumbnails, while treating native narration as discarded work would incorrectly refund delivered audio. Legacy recovery must not silently change approved outputs.

**How to apply:** Resolve footage dependencies in story order before final assembly; retain raw checkpoints for retries and preserve the target narration, never the source clip's audio. End cards use literal approved text/uploaded logos and a real frame, not another AI depiction of the doctor.