---
name: NVIDIA capability contracts
description: Fail-closed compatibility, activation, and health rules for hosted NVIDIA Catalog and self-hosted NIM deployments.
---

Treat deployment kind, capability, model, and protocol as one verified contract. Live model discovery is informational and must never expand compatibility or activation by itself. Keep text and multimodal health independent even when both use an OpenAI-compatible chat API.

**Why:** NVIDIA model listings can mix generation models with embeddings, rerankers, retrieval models, and models whose endpoint or output contract differs. A shared breaker can also make an outage in one capability incorrectly disable another.

**How to apply:** Add a model only after its request, response, streaming or polling, media validation, and accounting contract are verified. Require a fresh successful capability test and an exact usable price before activation; invalidate dependent tests when shared credentials rotate and revoke activation when an explicit price is removed.