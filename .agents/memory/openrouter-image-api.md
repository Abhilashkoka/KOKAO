---
name: OpenRouter image API
description: Current OpenRouter contracts for generating images and discovering image-capable models.
---

Use OpenRouter's dedicated Images API for image generation. Do not route image-output models through chat completions with output modalities, and do not treat the general models catalog as authoritative for image availability.

**Why:** OpenRouter moved image generation to a dedicated API. The legacy chat-completions contract rejected valid image models with a misleading "no endpoints support the requested output modalities" 404, while the same frozen model succeeded through the Images API.

**How to apply:** Generate through `POST /api/v1/images`; discover models and endpoint-specific capabilities/pricing through `/api/v1/images/models` and its per-model endpoints. Contract tests should cover aspect ratio, reference images, base64 output, and reported usage.