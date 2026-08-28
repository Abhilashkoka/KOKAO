---
name: NVIDIA capability contracts
description: Fail-closed compatibility, activation, and health rules for hosted NVIDIA Catalog and self-hosted NIM deployments.
---

Treat deployment kind, capability, model, and protocol as one verified contract. Live model discovery is informational and must never expand compatibility or activation by itself. Keep text and multimodal health independent even when both use an OpenAI-compatible chat API.

**Why:** NVIDIA model listings can mix generation models with embeddings, rerankers, retrieval models, and models whose endpoint or output contract differs. A shared breaker can also make an outage in one capability incorrectly disable another.

**How to apply:** Add a model only after its request, response, streaming or polling, media validation, and accounting contract are verified. Require a fresh successful capability test and an exact usable price before activation; invalidate dependent tests when shared credentials rotate and revoke activation when an explicit price is removed.

Hosted model retirement may arrive as HTTP 410 even while the catalog endpoint itself remains healthy. A successful catalog probe is therefore not deployment health, and a retired model must remain disabled rather than being retried or silently replaced by a newly discovered ID.

Hosted API Catalog qualification is deployment-kind specific. NVIDIA's free serverless preview rate is exact only for prototyping and is not a production tariff; a hosted contract must remain production-ineligible until production terms are known. Never copy a hosted qualification into the self-hosted allowlist: an independently operated NIM needs its own live endpoint, generation, streaming, usage, attribution, licensing, and price evidence.

**Why:** Treating an OpenAI-compatible hosted response as proof for an arbitrary self-hosted URL creates a deployment-kind switch that bypasses the production activation block.

**How to apply:** Keep hosted and self-hosted contract entries separate even when model IDs and nominal protocols match. Activation must check the exact kind-specific contract at runtime, not only when configuration is saved.