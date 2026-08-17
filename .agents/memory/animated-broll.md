---
name: Animated AI b-roll & governed motion instruction
description: How topic-video "ai_video" mode and the Prompt Kit video_motion suffix work
---

- Topic videos have a third generated-visuals mode `ai_video`: same b-roll planner/stills as `ai` (plan-reuse flow stays "broll"), but stills go through image-to-video (character-mode loop/trim + 25-min deadline). 3 wallet units/paragraph (ai=2, character=4).
- The image-to-video motion suffix ("Subtle natural motion, cinematic.") is governed by Prompt Kit flow `video_motion` via a minimal helper: block contents joined in order, no layer headers, fail-open to the built-in wording. It is a one-clause prompt suffix, NOT a compiled governed prompt.
- **Why:** the full `getGovernedPrompt` output (with "## System rules" headers) is unusable as a prompt suffix; and generation must never break on Kit/DB failure.
- **How to apply:** any new image-to-video call site should use the shared motion-instruction helper; unit tests must mock the helper (or promptKit) so assertions don't depend on dev-DB Kit state.
