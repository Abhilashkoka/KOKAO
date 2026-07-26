---
name: Replicate video model input mapping
description: Each Replicate video model family names its start-image field differently; a wrong field is silently ignored (no error) and the photo's subject never appears.
---
Replicate does NOT reliably 422 on unknown input keys — some models silently ignore them. So a missing family branch in the videoGen buildInput means "Animate Photo" generates from text alone with a *successful* job (real incident: alibaba/happyhorse wants `images: [dataUri]` array, got `image`, ignored it).
**Why:** silent subject-loss is invisible in logs/tests; only the delivered video shows it.
**How to apply:** when adding any image-to-video model to the catalog (or accepting a free-text override), verify its live input schema via `GET api.replicate.com/v1/models/{owner}/{name}` (latest_version.openapi_schema Input properties), add a family branch if the photo field differs, and extend the catalog-mapping test in `replicateInput.test.ts`.
