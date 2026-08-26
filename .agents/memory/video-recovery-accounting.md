---
name: Video recovery accounting
description: Durable rules for resuming multi-stage paid video work without double charging or unfunded provider calls.
---

Every paid provider success must receive a unique chain event and be durably recorded before downstream normalization, composition, QA, or upload work. A receipt alone is billable history, but it is reusable only when its complete tenant-owned artifact was also persisted and validated.

**Why:** Downstream or storage failures can happen after a provider has charged. Treating a bare receipt as reusable creates an unfunded regeneration; waiting until downstream work finishes loses the charge and causes a duplicate provider call on retry.

**How to apply:** Persist receipt first, then artifact path, and mark accounting exactly once. Calculate every retry’s missing work from the immutable full chain operation baseline—not a prior child’s reduced reservation—then subtract only complete validated checkpoints. Persist generated plans before the first downstream stage, and give unavoidable regeneration a distinct operation identity.