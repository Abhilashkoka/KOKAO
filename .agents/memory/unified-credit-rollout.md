---
name: Unified credit rollout
description: Safety and accounting rules for replacing separate quotas with one credit balance.
---

The unified-credit system must start in shadow mode. Meter provider calls where spend occurs, including retries and paid failures, and reconcile those totals against provider invoices before enabling enforcement.

The enforcement release decision requires a complete live shadow billing window
and matching provider invoice evidence. A partial account audit or development
test events cannot establish approval; unknown paid-failure or rate-key coverage
must remain a no-go rather than an accepted zero variance.

**Why:** Route-level quota reservations miss provider work performed deep inside generation pipelines. Charging from an unreconciled rate card can undercharge customers, lose money, or debit inconsistently.

Meter at the innermost paid submission boundary, not around a wrapper that may hide provider retries. Context must be explicit: a tenant context for billable work, or `null` for health checks and admin playground calls.

Operation receipts are tenant-scoped. A successful dispatch or an unresolved crash blocks replay of the same operation; a fully refunded failure advances a persisted retry ordinal so recovered work can be charged safely.

Mutually exclusive retries and provider fallbacks must share one logical operation family even when their diagnostic operation keys differ. A replay-block error is terminal at every retry, health, and fallback boundary; otherwise re-entry can reset local counters and dispatch through an earlier refunded attempt.

Actual-quantity operations reserve a documented upper bound before dispatch using one immutable unit-rate snapshot, then settle downward by idempotent refund. Never depend on an extra debit after delivering provider output.

**How to apply:** Keep purchased credits non-expiring and granted credits expiring, spend granted credits first, give every provider attempt a stable base operation identity, and only switch to enforce after every material provider path is metered and invoice totals reconcile.

Enforcement readiness also requires billing-rail isolation and one consistent funding decision from route reservation through provider dispatch.

**Why:** Invoice reconciliation alone cannot prevent a quota/wallet reservation followed by a second debit from the global credit meter, or a mode change between those boundaries.

**How to apply:** Require whole-flow quota, wallet, and credits tests (including mode changes) before enabling enforcement. Do not treat a passed reconciliation gate as sufficient authorization to charge customers.

Provider credit enforcement is authorized by the server's frozen funding decision, not by a fresh global-mode or tenant-mode lookup. Legacy-funded pipelines remain on their original quota/wallet rail; adding metering does not migrate them to credits.

**Why:** A mode switch after acceptance must neither add a second charge to reserved work nor remove the only charge from credits-funded work. Nested operations with their own wallet reservation must not inherit credit-debit authorization from their parent.

**How to apply:** Carry the funding decision through provider context copies and asynchronous job boundaries. Charge credits only for explicitly credit-funded work; retain legacy accounting for pipelines not migrated as a complete unit.