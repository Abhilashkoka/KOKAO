---
name: Topic-video visual uniformity
description: Design rules for character costume locking and AI b-roll style consistency in the topic-video pipeline.
---

# Topic-video visual uniformity

- **Character costume is fixed for the whole video unless the user wrote wardrobe notes.** Enforced in two layers in the scene director: the prompt branches on trimmed notes (no-notes prompt has no "story calls for a change" escape hatch), and the parser hard-clamps every scene's outfitId to the locked outfit when notes are absent or whitespace-only. The parser clamp is the real guarantee — prompt-only fixes fail when the model ignores instructions. With real notes, nothing is clamped.
- **AI b-roll consistency is style-only, never first-image anchoring.** The Art Director returns one style clause appended to every scene's image prompt (length-bounded ~200 chars). Do NOT anchor b-roll scene N on scene 1's image the way character keyframes anchor on the outfit photo: b-roll subjects are supposed to differ per scene, and image anchoring drags subject content along with palette. Character identity, by contrast, IS image-anchored (keyframes are edits of the outfit reference photo) and needs no seed tricks.
- Fail-soft is sacred here: missing/blank/wrong-type style leaves prompts byte-identical; planning failures fall back to narration-derived prompts with the same warning.
- Single-clip character text-to-video (characterClip) has no scenes, hence no uniformity problem; multi-scene treatment belongs to future storyboard work.

**Why:** the "or the story" prompt clause let characters change costume mid-video with no user request, and independently-planned b-roll prompts drifted in palette/grade into a stock-collage look.
**How to apply:** when editing scene-director or art-director prompts/parsers in `lib/videoGen/topicVideo/`, keep the parser clamp and never replace style-append with image anchoring for b-roll.
