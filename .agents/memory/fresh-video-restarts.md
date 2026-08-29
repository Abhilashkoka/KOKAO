---
name: Fresh video restarts
description: Accounting and concurrency rules for restarting a failed video without reusing prior provider work.
---

A clean restart and a checkpoint-reusing retry are mutually exclusive child types for one failed source. Both must check every child-lineage flavor under the same source lock. A clean child copies only user-approved inputs/configuration, runs current preflight and pricing, and must not inherit generated assets, receipts, recovery metadata, or render state.

**Why:** Checking only same-type children allows a retry and clean restart to race into two funded children. Generic wallet estimates also under-reserve direct models whose current price depends on variant details.

**How to apply:** Treat funding, child creation, and source retirement as one atomic state transition. Recovery must prioritize funded fresh children over generic stale-job reclamation, while preserving the source diagnostics.