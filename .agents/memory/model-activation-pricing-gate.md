---
name: Model activation pricing gate
description: Admin model activation auto-syncs provider prices into ai_model_prices and refuses unpriced models
---

- The three admin gen-settings PUTs (text/image/video) call `syncActivatedModelPricing` before persisting: live catalog price (OpenRouter API; Replicate page scrape via `lookupReplicateUnitPricing` for structured $/image, $/second, $/video) is upserted into ai_model_prices; a model with no catalog price AND no manual row 400s with a message pointing to the Actual AI cost tracking card.
- **Why:** actual-cost tracking must never run blind on a newly activated model, and prices should track the provider website rather than drift.
- Merge rule: live-resolved fields overwrite (deliberate — "cost directly updated from provider" was the requirement); fields the lookup didn't resolve preserve the existing exact-provider row; failed lookups never erase manual rows; a model-only row under any provider counts as priced.
- Image "auto" routing is NOT gated (builtin providers have no catalog; gating would make auto unusable) — instead all provider defaults get a best-effort price sync on save. Runtime fallback/failover chains are also ungated by design: cost capture stays best-effort NULL, never blocks generation.
- Lookups run in parallel; catalogs have 1h caches + inflight dedupe + platformFetch timeouts, so multi-model saves stay bounded.
- Test pitfall: any test that `vi.mock`s `../lib/replicateCatalog` must stub ALL exported lookups (Pricing, TokenPricing, UnitPricing) or unrelated route imports get undefined functions. Restore gen selections via the lib setters in afterAll — the routes would re-run the gate.
