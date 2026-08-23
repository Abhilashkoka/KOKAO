---
name: Durable successful-work wallet settlement
description: Accounting invariants for retrying a final wallet charge after AI work has succeeded.
---

Register paid provider intent before the external call and freeze its exact target charge there. Provider success must become a durable, terminal refund barrier before local parsing/storage continues: begin, outcome confirmation, settlement enqueue, and refund all serialize reservation-first on the same lifecycle lock. Only authoritative provider rejection may become refundable; timeout, connection loss, malformed success responses, and other ambiguous outcomes remain pending for provider reconciliation.

**Why:** A crash can happen after the provider completes but before settlement handoff, and a timeout does not prove the provider failed. Without pre-call intent, a durable success receipt, and shared locking, recovery can lose a valid charge or race it into a refund; without ledger-level idempotency, retry can double-charge.

**How to apply:** Every new paid provider path needs a recoverable operation key or provider status lookup, an acknowledgement hook at the earliest success boundary, explicit confirmed-vs-ambiguous failure classification, and idempotent boot/periodic reconciliation that never reruns generation.