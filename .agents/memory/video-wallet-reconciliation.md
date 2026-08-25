---
name: Video wallet reconciliation
description: Durable rules for exact multi-operation video billing and safe historical corrections.
---

Successful video billing is the sum of every durable visual and lip-sync provider event, with the platform fee applied once to that raw total. Narration keeps its own reservation lifecycle and is added once when rebuilding displayed spend from the full linked ledger chain. Missing event prices are terminal configuration errors, never a reason to use a flat estimate.

**Why:** Aggregate fallback estimates undercharge mixed-model and failover jobs whenever one provider event is unpriced. Historical correction can also race a queued original settlement and permanently produce the wrong total if it runs before that settlement becomes immutable.

**How to apply:** Gate every selected, chained, failover, portrait, and lip-sync provider call on authoritative pricing. For corrections, lock the main reservation, require an original settle ledger anchor, reject pending/processing/failed settlement retries, and write one idempotent true-up for only the remaining difference.