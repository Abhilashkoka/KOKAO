---
name: Finite AI quota reservations
description: Concurrency and stale-recovery rules for finite monthly AI quota.
---

Finite AI quota must be reserved durably before a provider call, not inferred only from already-settled usage.

**Why:** Concurrent requests can both observe the final available unit before either records success. Stale-hold cleanup has a second race: if a live request loses an expired hold and later recreates quota during settlement, it can oversubscribe a slot that another request already claimed.

**How to apply:** Serialize each tenant's finite-quota availability decision, persist a pending hold that counts toward usage, renew it while work is live, settle it in place, and delete it on failure. If a hold is genuinely lost or reclaimed, record non-quota reconciliation telemetry; never create a replacement quota event.