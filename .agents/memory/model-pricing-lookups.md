---
name: Model pricing lookups
description: Non-obvious constraints in official provider pricing catalogs and admin imports
---

- Text-gen (OpenRouter): public keyless catalog `https://openrouter.ai/api/v1/models`; per-token USD → per-1M. Attached to GET /ai/models (openrouter provider only) + a superadmin draft endpoint.
- Video (Replicate): the REST API exposes NO pricing (verified with a live token). Pricing lives only in the public model page HTML as embedded JSON `"prices": [{"price": "$0.40", "title": "per second of output video"...}]` — scrape + regex-extract, collapse same-titled variants into a range, keep the provider's own price strings ("$0.20" not "$0.2").

**Why:** avoids hardcoding prices that drift; API-first attempts fail silently (pricing field simply absent).

**How to apply:** both catalogs follow the same shape — 1h in-memory cache + inflight dedupe, fail-soft (stale cache or null, never throw), strict slug/id validation before fetch, and the pricing endpoints return an entry for EVERY submitted id (null when unknown) so the UI never shows a permanent loading placeholder. Some model pages 404 (renamed/delisted) → null is expected. Orval partial query options need an explicit queryKey.

**2026-08-05:** replicate.com model pages return 503 to server-side fetches from the Replit environment (Cloudflare block), so the scrape-based video/image price lookup fails and activation falls back to requiring a manual catalog row. User chose to keep manual entry rather than a baked-in fallback price list. OpenRouter IMAGE models now auto-price via the catalog's image_output per-token rate (see modelPricingSync.ts).

**Admin URL imports:** accept only canonical public HTTPS Replicate/OpenRouter model-page URLs. Never fetch the submitted URL; parse provider/model identity first and use the fixed-host catalog reader. Preview is read-only. Confirm must revalidate the URL identity and persist the admin-reviewed values, not silently re-fetch/overwrite them.

**Wallet-targeted imports:** require both provider and model to match the selected pending row, then await the first fail-soft true-up attempt before responding so the client can refresh from completion-aware state.

**Google catalog locale:** Google redirects the Gemini pricing page according to the server environment (observed `hl=zh-tw` from Replit), which silently breaks English-label parsers. Pin both `?hl=en` and an English `Accept-Language` header on the fixed catalog request.

**Why:** the provider can return HTTP 200 with a complete but localized table, so network-success checks do not reveal the missing-price failure.

**How to apply:** any parser that relies on provider-published labels must make locale deterministic at the fixed catalog reader and verify the live lookup, not only an English fixture.

**Active model inventory:** a provider's curated dropdown is not necessarily its complete runtime inventory because a persisted free-text admin override can remain effective after catalog edits. Bulk pricing sync must union the curated catalog, fixed workflow models (such as lip-sync), and current effective overrides; known retired overrides should be neutralized explicitly rather than silently priced.

**Why:** removing a stale option from the UI alone does not deactivate a value already stored in settings, which can leave a callable model absent from both pricing sync and the admin audit surface.

**How to apply:** dedupe by canonical provider slug, label override-only entries clearly, and never include arbitrary provider models unless they are actually selected or otherwise part of a KOKAO-owned workflow.
