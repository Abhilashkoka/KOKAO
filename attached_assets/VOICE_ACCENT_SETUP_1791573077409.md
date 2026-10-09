# Voice accent fix — setup

## What it fixes
Cloned brand voices were narrating with an American English accent instead of the speaker's own (e.g. Indian English).

**Root causes found in the repo**
1. `elevenLabsSpeak` sent no `voice_settings`, so ElevenLabs used defaults (similarity 0.75), which lets instant clones drift to a generic US read.
2. Narration is spoken one sentence per API call with no context, so each short sentence re-derives the voice and loses the accent.
3. The "Recording accent" picked in the UI (`indian_english`) is stored as a label only and never reaches synthesis. That is fine, since the accent has to come from the clone itself; this patch makes the clone's accent stick.

## Changes
- `lib/voiceClone/index.ts`: accent-holding `voice_settings` (similarity 0.9, stability 0.55, style 0, speaker boost), `previous_text`/`next_text` support, `ELEVENLABS_TTS_MODEL` env override.
- `topicVideo/narration.ts`: passes neighbouring sentences on every brand-voice call.
- Test updated for the new call shape.

## Apply
```bash
git am voice-accent.patch
pnpm run typecheck
```
No migrations, no new env vars required.

## Optional
- `ELEVENLABS_TTS_MODEL=eleven_v3` (Replit Secrets) to trial ElevenLabs v3 if the accent still drifts. Leave unset to keep `eleven_multilingual_v2`.

## Still matters (user side)
- The clone copies the sample. Re-clone with **1–2 minutes** of clean, single-speaker audio in the target accent; short or noisy samples drift no matter what.
- Existing clones benefit immediately; no re-clone needed unless the sample was poor.

## Verify
1. Brand Kit → Brand Voice → **Preview** an Indian English clone.
2. Generate a short Topic-to-Video with "Use brand voice" on; the accent should hold across all sentences.
