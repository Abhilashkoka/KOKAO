---
name: Guided cast checkpoints
description: Durable accounting and restart invariants for paid generated-character work in guided stories.
---

Generated cast assets must use stable, revision-bound per-role operations with explicit pre-provider, uncertain-outcome, provider-success, upload-success, and settled checkpoints. Ambiguous provider outcomes remain blocked for reconciliation: never refund or automatically retry them. Known-success checkpoints may resume only upload, settlement, or final commit without repeating provider work.

**Why:** A process can stop or a request can become ambiguous at any provider/upload/settlement boundary. Treating uncertainty as failure can both refund and duplicate paid work; rejecting known-success checkpoints can strand paid assets.

**How to apply:** Before resuming or committing wallet-funded cast work, lock and validate the durable provider operation and reserve/settlement ledger rows against tenant, stable operation key, purpose, units, amount, provider, model, and allowed state. Approval must also lock the current draft and reject revision, cast, or scene-fingerprint drift.

Narration voice is not an input to fictional cast image generation. A known-success visual checkpoint may adopt a changed voice without repeating or discarding paid image work; in-flight or uncertain provider checkpoints remain fail-closed. Durable image handoffs must preserve and validate the provider's actual supported format (PNG or JPEG), including the matching upload content type.

Wallet settlement may finish before the draft advances from provider-success to upload-success. Recovery must accept a settled, non-refunded provider operation at the earlier visual checkpoint and resume the saved-byte upload; settlement order must never strand paid cast work.