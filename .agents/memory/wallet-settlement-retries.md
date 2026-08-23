---
name: Durable successful-work wallet settlement
description: Accounting invariants for retrying a final wallet charge after AI work has succeeded.
---

Once AI work succeeds, persist its exact target charge before attempting the final wallet mutation. The durable record becomes a refund barrier: enqueue and refund must serialize on the same reservation lock, and settlement must detect an existing terminal ledger entry before changing the balance.

**Why:** A transient settlement outage must leave the successful work charged for eventual reconciliation, not restore its reservation. Without a shared lock, enqueue and refund can race; without ledger-level idempotency, a crash after commit can double-charge on retry.

**How to apply:** Every new post-success AI charging path must use the durable settlement lifecycle and must not refund after successful provider work. Run its boot/periodic recovery independently from unrelated initialization chains so another subsystem cannot strand pending charges.