---
name: Brand voice cloning
description: Durable decisions behind the Brand Kit cloned narration voice
---

- Whole-track-only rule: ANY brand-voice narration failure (even a permanent 4xx like a deleted voice) falls back to the stock TTS chain for the ENTIRE track. **Why:** a stock-narrated video beats a dead job, and mixing voices/sample rates mid-track is never acceptable. Clone/preview routes are different — they surface errors instead of falling back.
- The brand-voice REMOVAL endpoint is deliberately NOT gated by the `brandVoiceClone` kill switch. **Why:** cleanup must keep working after the feature is disabled, or provider-side clones are orphaned forever.
- ElevenLabs quirks: cloning is synchronous (no poll step) and TTS returns raw PCM — wrap it in a WAV header locally so it parses with the shared RIFF reader like every other narration provider.
- Base-video audio extracts are durable temporary records, not client-owned cleanup: register before storage upload, TTL-sweep abandoned rows, and atomically claim for clone vs cancellation. **Why:** browser crashes and overlapping requests otherwise leak private recordings or delete a clone's input. **How to apply:** a committed voice adopts its object by removing only the temporary tracker; cleanup/sweeps may only delete an unclaimed, unreferenced tracked object.
