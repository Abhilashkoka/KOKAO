---
name: Image fallback failure classes
description: Provider responses that look terminal by HTTP status but are safe to route to another configured image provider.
---

Treat an image response that explicitly reports a no-output `STOP` with no safety block as provider-local, not as a rejected user prompt. Likewise, a provider-specific endpoint/model-not-found response says that provider is misconfigured or unavailable; it does not imply the same request will fail elsewhere. When fallback is enabled, both may continue to another compatible provider. Ordinary 400/404 responses remain terminal.

**Why:** A Guided Story reference sheet was stranded after a successful portrait because OpenRouter/Gemini returned HTTP 400 with `STOP` and a null block reason. The first fallback then returned a provider-specific model-not-found 404. Both failures produced no image and were refunded, while the same request succeeded through the next provider.

**How to apply:** Keep matching narrow and metadata-specific. Preserve billing checkpoints, attempt only configured compatible providers, and do not reinterpret actual safety blocks or generic client errors as retryable.