---
name: Unified credit rollout
description: Safety and accounting rules for replacing separate quotas with one credit balance.
---

The unified-credit system must start in shadow mode. Meter provider calls where spend occurs, including retries and paid failures, and reconcile those totals against provider invoices before enabling enforcement.

**Why:** Route-level quota reservations miss provider work performed deep inside generation pipelines. Charging from an unreconciled rate card can undercharge customers, lose money, or debit inconsistently.

Meter at the innermost paid submission boundary, not around a wrapper that may hide provider retries. Context must be explicit: a tenant context for billable work, or `null` for health checks and admin playground calls.

Operation receipts are tenant-scoped. A successful dispatch or an unresolved crash blocks replay of the same operation; a fully refunded failure advances a persisted retry ordinal so recovered work can be charged safely.

Mutually exclusive retries and provider fallbacks must share one logical operation family even when their diagnostic operation keys differ. A replay-block error is terminal at every retry, health, and fallback boundary; otherwise re-entry can reset local counters and dispatch through an earlier refunded attempt.

Actual-quantity operations reserve a documented upper bound before dispatch using one immutable unit-rate snapshot, then settle downward by idempotent refund. Never depend on an extra debit after delivering provider output.

**How to apply:** Keep purchased credits non-expiring and granted credits expiring, spend granted credits first, give every provider attempt a stable base operation identity, and only switch to enforce after every material provider path is metered and invoice totals reconcile.