---
name: Video recovery accounting
description: Durable rules for resuming multi-stage paid video work without double charging or unfunded provider calls.
---

Every paid provider success must receive a unique chain event and be durably recorded before downstream normalization, composition, QA, or upload work. A failed video job is customer-charge-free even when providers incurred cost. If a retry later delivers a video, charge only receipts proven present in the final successful job's persisted checkpoints; discarded failed-attempt work remains free.

**Why:** The customer pays for a delivered video, not provider attempts. Chain membership alone cannot prove delivery: a retry may replace a failed attempt's asset, while another retry may reuse it. Charging every ancestor receipt overbills replacements; dropping all ancestor receipts makes reused delivered work free.

**How to apply:** Persist receipt first, then artifact path. Refund each terminal failed wallet job to zero idempotently. Calculate retry funding from the immutable full-chain baseline, subtract only complete validated checkpoints, and reconcile a successful chain from the final job's delivered receipt membership. Give regenerated work a distinct operation identity.

Optional finishing stages are different when the failed job deliberately retains a usable base deliverable: settle every newly proven provider receipt exactly once, refund only unrun reserved capacity, and mark receipts copied into recovery children as already accounted.

**Why:** A finishing-stage failure can still leave completed base work and paid finishing calls attached to the retained output. Treating the whole job as zero-cost refunds delivered work; treating inherited recovery receipts as new work double-charges it.

**How to apply:** Filter `accounted` receipts before all child failure usage, credit, and wallet calculations. Freeze finishing prices before funding, and run recovery preflight for missing paid stages independently of unrelated resilience flags.