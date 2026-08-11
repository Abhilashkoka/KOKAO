---
name: Lip-sync (Spokesperson) videos
description: LatentSync-on-Replicate lip-sync engine — Files API uploads, consent hard gate, voice fallback chain.
---

- Replicate's LatentSync input is exactly `{video, audio}` as URIs. Both are far past data-URI limits, so upload each through the Replicate Files API (`POST /v1/files` multipart, use `urls.get`) before creating the prediction.
- **Why:** wrong/omitted input fields are silently ignored by Replicate (see replicate-video-inputs); data URIs of video size 413 or hang.
- Likeness consent is a hard gate at BOTH ends: the route 400s without `lipSyncConsent: true`, and the job runner re-checks the persisted option before generating (defense-in-depth against recovery/manual/legacy rows).
- Voice chain: brand kit cloned voice (behind brandVoiceClone flag, whole-track fallback inside synthesizeNarration) → kit preset voice → stock voice. `brandKitId` is allowed for lip_sync for voice only — no visual branding.
- Kill switch `lipSync` gates the route AND the runner branch; preflight requires Replicate configured + at least one TTS provider before funding.
- Output keeps the base video's framing — no aspect normalization; QA only asserts min duration + audio present.
