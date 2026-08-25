---
name: Video wallet reconciliation
description: Durable rules for exact multi-operation video billing and safe historical corrections.
---

Successful retry-chain video billing is the sum of every durable narration, visual, music, B-roll, and lip-sync provider event, with the platform fee applied once to the complete raw total and rounded once. The fee percentage is dynamic: always read the current value configured through Actual AI Cost Tracking; never hardcode 20% or any other percentage. Provider events need stable identities that survive copied checkpoints, and chain roots must be resolved transitively because legacy retries may point to an intermediate parent. Missing event prices keep the chain pending; never use a flat estimate.

**Why:** The admin controls the platform fee and may change it from 20%; a fixed value silently misprices new work. Aggregate fallback estimates also undercharge mixed-model and failover jobs whenever one provider event is unpriced. Historical correction can race a queued original settlement and permanently produce the wrong total if it runs before that settlement becomes immutable.

**How to apply:** Gate every selected, chained, failover, portrait, and lip-sync provider call on authoritative pricing. Resolve the configured fee at settlement/reconciliation time. For corrections, lock one settled video reservation, reject pending/processing/failed settlements anywhere in the transitive chain, deduplicate copied events by stable identity, and write one chain-keyed idempotent true-up for only the remaining difference. Historical reports stay read-only until collection is separately approved.