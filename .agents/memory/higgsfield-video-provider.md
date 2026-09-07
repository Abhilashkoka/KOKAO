---
name: Higgsfield video provider
description: Non-obvious request and polling contracts for Higgsfield video generation.
---

Higgsfield model identifiers are API endpoint paths, not request-body model names. Only paths published in Higgsfield's current OpenAPI should be activatable. Veo routes accept strict duration, resolution, aspect-ratio, and audio fields; other families use their own schemas.

**Why:** Treating a marketing product name as an API route, or treating every model as one generic request shape, causes terminal provider 4xx errors after users have already waited.

**How to apply:** Verify paths and schemas against the public OpenAPI before activation. Snap Veo duration to the supported string enum, map unsupported aspects to an orientation the compositor can crop, and treat generated audio as opt-in.

Higgsfield image/video inputs must be uploaded through its file-upload flow; model requests receive the returned public HTTPS URL, never a data URI.

**Why:** Higgsfield's documented model inputs are fetchable URLs, and inline base64 images are rejected. Provider-returned upload URLs are also an SSRF boundary.

**How to apply:** Request a presigned target, validate HTTPS/public hosts, PUT bytes with exactly the returned upload headers and no API auth, then use `public_url` in the model request.

Completed output URLs may be nested differently across Higgsfield status responses and expire quickly.

**Why:** Assuming one undocumented nesting path can mark a billed successful generation as failed, while retaining the provider URL would eventually leave a broken asset.

**How to apply:** Search bounded status payloads for a credible video-file URL while excluding status/cancel/non-video links, download immediately, and persist the bytes in tenant storage.

Higgsfield is also an image provider. Its default image route is the documented `higgsfield-ai/soul/v2/standard` endpoint, using the same account credential as video.

**Why:** Higgsfield credentials are account-wide, while image and video settings are separate capabilities in KOKAO.

**How to apply:** Reuse the saved video credential when no image-specific key exists. Soul v2 Standard is text-to-image only in the current adapter; do not claim reference-image, transparency, or masked-edit support.

Higgsfield Veo 3.1 routes provide native synchronized audio for Guided Story. Higgsfield's public API does not currently publish a `bytedance/seedance-2.5` route; do not activate or silently remap it. OpenRouter's model with that name is a separate contract.

**Why:** Marketing availability does not guarantee API availability. A guessed endpoint caused immediate provider rejection without a request ID, while silent remapping would change model quality and capabilities.

**How to apply:** Keep native-audio capability provider-and-model specific. Use documented Higgsfield Veo routes with `generate_audio`; require a newly published schema before enabling Higgsfield Seedance 2.5.