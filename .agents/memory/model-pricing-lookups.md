---
name: Model pricing lookups
description: How live model pricing gets into admin/user dropdowns (OpenRouter + Replicate)
---

- Text-gen (OpenRouter): public keyless catalog `https://openrouter.ai/api/v1/models`; per-token USD → per-1M. Attached to GET /ai/models (openrouter provider only) + a superadmin draft endpoint.
- Video (Replicate): the REST API exposes NO pricing (verified with a live token). Pricing lives only in the public model page HTML as embedded JSON `"prices": [{"price": "$0.40", "title": "per second of output video"...}]` — scrape + regex-extract, collapse same-titled variants into a range, keep the provider's own price strings ("$0.20" not "$0.2").

**Why:** avoids hardcoding prices that drift; API-first attempts fail silently (pricing field simply absent).

**How to apply:** both catalogs follow the same shape — 1h in-memory cache + inflight dedupe, fail-soft (stale cache or null, never throw), strict slug/id validation before fetch, and the pricing endpoints return an entry for EVERY submitted id (null when unknown) so the UI never shows a permanent loading placeholder. Some model pages 404 (renamed/delisted) → null is expected. Orval partial query options need an explicit queryKey.
