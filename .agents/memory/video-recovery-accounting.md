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

Homogeneous composite workflows such as direct Guided Story must reserve each missing provider operation at the longest duration allowed by the frozen model contract, then refund the unused difference. A flat per-unit display estimate can underfund longer scenes even when the missing-operation count is correct.

**Why:** Scene durations are quantized independently (for example, 5/8/10 seconds), while a recovery reservation may cover only one missing 10-second scene. Counting one unit at a generic display rate does not guarantee enough held funding for that exact receipt.

**How to apply:** Use the immutable provider/model/variant snapshot and maximum permitted duration to price direct Guided enqueue, recovery, and fresh restart holds. Do not include inherited `accounted` receipts in the current attempt.

Historical wallet reconciliation must distinguish saved event costs from current-catalog repricing, and saved fees from inferred current fees. An old display-spend snapshot alone is not evidence of a settled customer charge.

**Why:** Older succeeded jobs can retain open holds with no durable settlement retry. Chain analysis may silently reprice missing event costs at today's rates, and a failed source's fully refunded work must be reviewed against delivered child receipts before charging it.

**How to apply:** Inspect the entire chain's reservation/settle/refund lifecycle, expose cost provenance, and require explicit approval of any inferred historical fee and additional debit. Never label a report executable merely because a current-price total is computable.

Terminal failed settlement retries are not necessarily unpaid work: the ledger may already prove exact settlement or a complete refund.

**Why:** Historical outbox status can remain failed after a financial resolution. Treating that status alone as pending blocks otherwise safe conversion; ignoring all failures can instead conceal genuine liabilities.

**How to apply:** Require matching tenant-scoped reserve and resolution receipts before excluding a failed retry. Check every retry and all later conversion blockers; an exempt row must not short-circuit the remaining checks.