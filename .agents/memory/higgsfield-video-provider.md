---
name: Higgsfield video provider
description: Non-obvious request and polling contracts for Higgsfield video generation.
---

Higgsfield model identifiers are API endpoint paths, not request-body model names. Veo routes accept strict duration, resolution, aspect-ratio, and audio fields; Higgsfield Kling and Seedance routes accept only prompt plus an optional image and reject leaked Veo parameters.

**Why:** Treating every model as one generic request shape causes delayed provider 400s after users have already waited.

**How to apply:** Keep route-specific request builders. Snap Veo duration to the supported string enum, map unsupported aspects to an orientation the compositor can crop, and treat generated audio as opt-in.

Completed output URLs may be nested differently across Higgsfield status responses and expire quickly.

**Why:** Assuming one undocumented nesting path can mark a billed successful generation as failed, while retaining the provider URL would eventually leave a broken asset.

**How to apply:** Search bounded status payloads for a credible video-file URL while excluding status/cancel/non-video links, download immediately, and persist the bytes in tenant storage.

Higgsfield is also an image provider. Its default image route is the documented `higgsfield-ai/soul/v2/standard` endpoint, using the same account credential as video.

**Why:** Higgsfield credentials are account-wide, while image and video settings are separate capabilities in KOKAO.

**How to apply:** Reuse the saved video credential when no image-specific key exists. Soul v2 Standard is text-to-image only in the current adapter; do not claim reference-image, transparency, or masked-edit support.

Higgsfield Veo 3.1 text and image routes provide native synchronized audio for Guided Story; do not add a Replicate lip-sync pass unless the user explicitly requests separate finishing. Kling 2.5 remains non-audio.

**Why:** Treating all Higgsfield models as silent incorrectly blocks native-audio Guided Stories on a Replicate credential and would replace provider-owned dialogue.

**How to apply:** Keep native-audio capability model-specific. Opt Higgsfield Veo into generated audio and skip intrinsic Replicate lip-sync; retain Replicate requirements for non-audio models or explicit finishing.