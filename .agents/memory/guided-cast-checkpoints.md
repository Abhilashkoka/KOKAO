---
name: Guided cast checkpoints
description: Durable accounting and restart invariants for paid generated-character work in guided stories.
---

Generated cast assets must use stable, revision-bound per-role operations with explicit pre-provider, uncertain-outcome, provider-success, upload-success, and settled checkpoints. Checkpoints are monotonic: recovery must never downgrade provider-success or upload-success back to funded. Ambiguous provider outcomes remain blocked for reconciliation: never refund or automatically retry them. Known-success checkpoints must retain validated bytes plus their detected MIME type, and may resume only upload, settlement, or final commit without repeating provider work.

**Why:** A process can stop or a request can become ambiguous at any provider/upload/settlement boundary. Treating uncertainty as failure can both refund and duplicate paid work; rejecting known-success checkpoints can strand paid assets.

**How to apply:** Before resuming or committing wallet-funded cast work, lock and validate the durable provider operation and reserve/settlement ledger rows against tenant, stable operation key, purpose, units, amount, provider, model, and allowed state. Approval must also lock the current draft and reject revision, cast, or scene-fingerprint drift.

Concurrent identical requests need a durable per-operation execution claim. Fence every checkpoint write, refund, and settlement with that claim; only stale pre-provider or known-success claims may be reclaimed, while provider-running claims remain fail-closed. Usage metering must have its own stable idempotency key because a provider/wallet receipt does not deduplicate quota telemetry.

Narration voice is not an input to fictional cast image generation. A known-success visual checkpoint may adopt a changed voice without repeating or discarding paid image work; in-flight or uncertain provider checkpoints remain fail-closed. Durable image handoffs must preserve and validate the provider's actual supported format (PNG or JPEG), including the matching upload content type.

Wallet settlement may finish before the draft advances from provider-success to upload-success. Recovery must accept a settled, non-refunded provider operation at the earlier visual checkpoint and resume the saved-byte upload; settlement order must never strand paid cast work.

A Guided Story draft may detach and re-approve a linked attempt only when the job is terminally failed and has no storyboard. Once any storyboard exists, its script/cast checkpoint stays immutable and recovery must continue through storyboard-specific controls.

**Why:** Provider failure before storyboard creation leaves no paid visual checkpoint to preserve, but treating that dead link as an active review strands the durable script.

**How to apply:** Verify the linked job belongs to the same tenant, is failed, and has a null storyboard before clearing the link during approval; fail closed for missing jobs, active jobs, review jobs, or failed jobs that retained a storyboard.

Inline cast-reference work must persist `queued` before any provider dispatch and then persist `running` successfully before the provider call begins. A queued claim is therefore safe to cancel after reload; a running claim is not reconcilable until a guard comfortably longer than the provider timeout has elapsed, and uncertain outcomes require explicit receipt inspection before retry.

**Why:** If “queued” can overlap live provider work, a recovery click can mark it failed while the original request is still billable, enabling duplicate work and charges.

**How to apply:** Keep finalization and storyboard approval blocked for queued, running, or outcome-unknown operations. Rebuild every affected scene from finalized references and invalidate previews whose structural fingerprint changes.

Protected-region and canonical-reference equality are mandatory for generated outfit derivatives, using only the character’s stored reviewed region. Immutable default outfits are exempt because they are the character’s original approved reference rather than a masked derivative.

**Why:** Trusting caller-supplied face rectangles lets clients self-attest identity preservation, while requiring derivative metadata on default outfits breaks ordinary saved-character selection.

**How to apply:** Reject derived outfit generation when the stored reviewed region is absent or differs from the request; recheck the stored region and canonical source during Guided finalization, but allow valid default outfits without derivative metadata.
