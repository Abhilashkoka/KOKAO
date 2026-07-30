---
name: Model activation pricing gate
description: How admin model activation matches saved cost-card prices and reports missing pricing
---

Activating a text/image/video model auto-syncs its provider catalog price into ai_model_prices; no price anywhere = 400, never silent.

- Price matching (findModelPrice / findPrice) is trimmed + case-insensitive on provider and model (SQL `lower(trim(col))`), with a same-kind model-under-any-provider fallback when no exact-provider row exists. upsertModelPrice trims provider/model on write.
- The catalog-merge path upserts onto the EXISTING row's stored provider/model spelling (not the request's) so a case-differing manual row is updated in place instead of duplicated.
- Rejection messages come from missingPricingError(entries) taking `{ model, kind, engine? }`; video callers name which engine (text-to-video / image-to-video) lacks pricing.
- **Test pitfall:** cleanup with `LIKE 'kokaotest/%'` misses rows with leading whitespace — clean with `lower(trim(model)) like ...`. A leftover whitespace-prefixed row makes "refuses unpriced model" tests flakily pass activation via the fallback.
