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