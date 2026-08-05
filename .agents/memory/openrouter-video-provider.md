---
name: OpenRouter video provider
description: OpenRouter async video API integration, its separate model/pricing catalog, key sharing, and the preflight selected-provider rule.
---

# OpenRouter video provider

- OpenRouter video models are NOT in `/api/v1/models` — use the dedicated keyless catalog `GET https://openrouter.ai/api/v1/videos/models` (per-second `pricing_skus`, `supported_durations`, `supported_aspect_ratios`, `supported_frame_images`).
- Generation is async: `POST /api/v1/videos` → poll `GET /api/v1/videos/{id}`; terminal statuses completed/failed/cancelled/expired; download from `unsigned_urls[0]`.
- Models accept only discrete durations (Veo 4/6/8, Sora 4/8/12/16/20, Kling O1 & WAN-2.6 & Hailuo-2.3 5/10); the provider snaps to the nearest allowed value or a 400 comes back.
- Start image goes in `frame_images` as `{frame_type:"first_frame", image_url:{url:<data URI>}}`.
- The video provider shares the admin's TEXT-gen OpenRouter key (`textgen_openrouter` row) as fallback — mirrors Replicate text sharing the video key. Tests that need "unconfigured video" must snapshot/remove/restore that shared row (preflight.test.ts does).
- Seedance bills by `video_tokens` — no per-second rate; pricing resolves null and falls through to manual entry, never guessed.

**Preflight rule:** `generateVideo` never fails over ACROSS providers (only across models within the selected one), so `preflightVideoJob` must evaluate only the SELECTED provider's configured/health state. Counting any healthy provider would fund jobs guaranteed to fail. If true cross-provider failover is ever added, relax preflight in the same change.
