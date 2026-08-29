---
name: Guided cast checkpoints
description: Durable accounting and restart invariants for paid generated-character work in guided stories.
---

Generated cast assets must use stable, revision-bound per-role operations with explicit pre-provider, uncertain-outcome, provider-success, upload-success, and settled checkpoints. Ambiguous provider outcomes remain blocked for reconciliation: never refund or automatically retry them. Known-success checkpoints may resume only upload, settlement, or final commit without repeating provider work.

**Why:** A process can stop or a request can become ambiguous at any provider/upload/settlement boundary. Treating uncertainty as failure can both refund and duplicate paid work; rejecting known-success checkpoints can strand paid assets.

**How to apply:** Before resuming or committing wallet-funded cast work, lock and validate the durable provider operation and reserve/settlement ledger rows against tenant, stable operation key, purpose, units, amount, provider, model, and allowed state. Approval must also lock the current draft and reject revision, cast, or scene-fingerprint drift.