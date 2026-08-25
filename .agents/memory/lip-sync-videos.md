---
name: Lip-sync (Spokesperson) videos
description: Replicate lip-sync engines — quality tiers, pricing gates, Files API uploads, consent hard gate, and voice fallback chain.
---

- Replicate's LatentSync input is exactly `{video, audio}` as URIs. Both are far past data-URI limits, so upload each through the Replicate Files API (`POST /v1/files` multipart, use `urls.get`) before creating the prediction.
- **Why:** wrong/omitted input fields are silently ignored by Replicate (see replicate-video-inputs); data URIs of video size 413 or hang.
- LatentSync is a Replicate community model: invoke an immutable `owner/name:version` reference via universal `POST /v1/predictions`. The official-model `/v1/models/{owner}/{name}/predictions` endpoint returns 404 even while the public model page is live.
- **Why:** production spokesperson jobs reached Replicate successfully but failed at prediction creation because the community model was sent to the official-model endpoint.
- **How to apply:** keep the LatentSync version pinned and regression-test the exact endpoint and request body independently from ordinary unversioned video models.
- Likeness consent is a hard gate at BOTH ends: the route 400s without `lipSyncConsent: true`, and the job runner re-checks the persisted option before generating (defense-in-depth against recovery/manual/legacy rows).
- Voice chain: brand kit cloned voice (behind brandVoiceClone flag, whole-track fallback inside synthesizeNarration) → kit preset voice → stock voice. `brandKitId` is allowed for lip_sync for voice only — no visual branding.
- Kill switch `lipSync` gates the route AND the runner branch; preflight requires Replicate configured + at least one TTS provider before funding.
- Output keeps the base video's framing — no aspect normalization; QA only asserts min duration + audio present.
- Standard video lip-sync uses pinned LatentSync; High Quality uses Sync Lipsync 2. Portrait animation owns its model choice, and localized dubbing stays pinned to Standard so quality changes do not silently widen scope.
- **Why:** model quality affects both provider behavior and cost; applying one global selection would accidentally change workflows the user never opted into.
- **How to apply:** persist the quality choice with the generation request, default legacy/missing values to Standard, and reset/hide the choice in portrait mode.
- High Quality is offerable only when its current provider price is known. Show the server-derived per-output-second rate before generation and attribute actual cost from inspected provider output duration, never requested or narration duration.
- **Why:** a guessed or missing rate can underfund a job, while narration duration can differ from the billable video returned by the provider.
- **How to apply:** sync the catalog price before exposing the option, fail before funding if it remains unknown, and record the selected model plus measured output seconds in provider usage.
- Sync Lipsync 2 needs visible, natural talking motion in the source footage; still or deliberately closed-mouth plates can remain closed even with correct audio and the High Quality model.
- **Why:** Sync processes independent chunks and preserves the source speaker's delivery style. Its vendor guidance explicitly identifies static/closed-mouth footage as a cause of little or no mouth movement.
- **How to apply:** generated source-plate prompts must ask for varied open-and-close mouth motion while remaining silent; uploaded-video UI must tell users to provide one front-facing, well-lit speaker already talking naturally.
- Curated presenter-overlay formats work with both Character Story and Character Dialogue. A saved character can satisfy the presenter slot; generated character footage is rendered first, then the reviewed supporting B-roll is composited over it.
- **Why:** templates describe the finished presentation format, not only an uploaded presenter source. Clearing the selection silently discarded a format users deliberately chose.
- **How to apply:** keep the selected template while switching between Character Story and Character Dialogue; pause on a provider-free media plan, keep Dialogue text immutable, and resolve/composite B-roll only after approval.
