---
name: Atlas Cloud provider
description: Safety and lifecycle rules for Atlas Cloud video generation and fictional-character assets.
---

Atlas Cloud is a distinct paid video provider; never reuse BytePlus model contracts, credentials, task IDs, prices, or asset IDs for it.

**Why:** Atlas is an aggregator with its own asynchronous prediction API and account-wide Asset Library. Marketing model names do not imply identical provider behavior.

**How to apply:** Fence every paid submit durably before POST, save accepted prediction IDs immediately, resume polling instead of resubmitting, and send unknown-cost events as NULL. Activation requires an authoritative price.

Only AI-generated fictional characters may enter the Atlas Asset Library. Uploaded, unknown-provenance, or BytePlus-verified identities must never reach Atlas through raw-image or asset paths.

**Why:** Atlas documents that real-human references require authorized assets, but its public API does not expose a KOKAO-compatible liveness/right-verification flow.

**How to apply:** Freeze provenance and provider-specific asset requirements in job snapshots, then re-check active tenant ownership at dispatch. Missing/deleted mappings fail closed. Since Atlas does not document Asset DELETE, block local deletion until documented GET returns 404 after console removal.

Provider-returned output URLs require address-pinned HTTPS transport: validate and connect to the same public IP while preserving TLS hostname/SNI.

**Why:** DNS validation followed by ordinary fetch permits DNS rebinding between lookup and connection.

**How to apply:** Reject redirects and private/reserved addresses, cap output bytes, and enforce one deadline over headers and streamed body.