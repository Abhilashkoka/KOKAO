---
name: Unified credit rollout
description: Safety and accounting rules for replacing separate quotas with one credit balance.
---

Purchased unified balances must remain visible even before credit-funded generation is enabled. Balance visibility and authorization to debit are separate decisions.

**Why:** Customers can purchase a unified pack during shadow rollout; hiding that balance behind the enforcement flag makes a successful payment appear lost.

**How to apply:** Display saved credits separately from legacy wallet/quota allowances, explain which balance currently funds generation, and refresh canonical balances after purchases and delayed payment confirmation without enabling enforcement.

An explicitly approved one-time wallet conversion may retain reviewed historical estimated-charge liabilities, without forgiving or finalizing them. Default conversion must continue blocking unresolved estimates.

**Why:** The user may choose to move available value while deferring uncertain legacy charges; transferring value is not approval to waive those charges or to enable credit-funded generation.

**How to apply:** Scope any internal exception to the exact reviewed pending ledger set, preserve those rows unchanged, retain all other blockers, and record the exception in linked conversion receipts.

Production credit billing starts in shadow mode. Meter provider calls where spend occurs, including retries and paid failures, and reconcile those totals against provider invoices before enabling production enforcement.

The production enforcement release decision requires a complete live shadow billing window
and matching provider invoice evidence. A partial account audit or development
test events cannot establish approval; unknown paid-failure or rate-key coverage
must remain a no-go rather than an accepted zero variance.

**Why:** Route-level quota reservations miss provider work performed deep inside generation pipelines. Charging from an unreconciled rate card can undercharge customers, lose money, or debit inconsistently.

Development may use explicitly approved saved-rate billing after behavior checks, separately from the production invoice gate.

**Why:** The user approved development deductions based on configured prices without provider invoices. These checks establish correct customer deductions, not provider-cost accuracy or profitability; that approval does not release production.

**How to apply:** Preserve exact saved prices (including explicit free rates), keep the production gate unchanged, scope the opt-in to development, and verify coverage, insufficient balance, durable refunds, and replay safety before activation.

Unknown provider outcomes must not be treated as confirmed failures when billing credits. Keep them reviewable and block automatic replay; only confirmed failures qualify for automatic refunds.

**Why:** A timeout can happen after a provider accepted paid work. Refunding and retrying that request can pay the provider twice. Refund obligations also need durable records so database outages do not silently discard them.

**How to apply:** Persist dispatch and refund state, distinguish missing dispatch from ambiguous dispatch, and allow recovery of an unstarted request only after its live-request lease expires.

Meter at the innermost paid submission boundary, not around a wrapper that may hide provider retries. Context must be explicit: a tenant context for billable work, or `null` for health checks and admin playground calls.

Operation receipts are tenant-scoped. A successful dispatch or an unresolved crash blocks replay of the same operation; a fully refunded failure advances a persisted retry ordinal so recovered work can be charged safely.

Mutually exclusive retries and provider fallbacks must share one logical operation family even when their diagnostic operation keys differ. A replay-block error is terminal at every retry, health, and fallback boundary; otherwise re-entry can reset local counters and dispatch through an earlier refunded attempt.

Actual-quantity operations reserve a documented upper bound before dispatch using one immutable unit-rate snapshot, then settle downward by idempotent refund. Never depend on an extra debit after delivering provider output.

**How to apply:** Keep purchased credits non-expiring and granted credits expiring, spend granted credits first, give every provider attempt a stable base operation identity, and only switch to enforce after every material provider path is metered and invoice totals reconcile.

Enforcement readiness also requires billing-rail isolation and one consistent funding decision from route reservation through provider dispatch.

**Why:** Invoice reconciliation alone cannot prevent a quota/wallet reservation followed by a second debit from the global credit meter, or a mode change between those boundaries.

**How to apply:** Require whole-flow quota, wallet, and credits tests (including mode changes) before enabling enforcement. Do not treat a passed reconciliation gate as sufficient authorization to charge customers.

Reward conversion must preserve the terms of existing earned value. Previously issued referral codes use their stored reward promise, not the owner's current plan overrides. A new expiring reward must never impose a deadline on an existing non-expiring goodwill balance.

**Why:** A shared grant-expiry timestamp cannot represent independent reward lots, and mutable plan overrides can silently change an already-issued referral promise.

**How to apply:** Freeze canonical reward amounts at issuance/redemption, preserve the more favorable existing expiry, and leave legacy balances intact pending explicit conversion. Account existence alone is not evidence that legacy conversion occurred; require a migration ledger receipt.

Provider credit enforcement is authorized by the server's frozen funding decision, not by a fresh global-mode or tenant-mode lookup. Legacy-funded pipelines remain on their original quota/wallet rail; adding metering does not migrate them to credits.

Wallet conversion must exchange value atomically, never grant credits while leaving spendable wallet money. Broad legacy migration must exclude wallet value, and historical wallet-source migration receipts require manual review before any further conversion.

**Why:** The former broad migration could grant wallet-derived credits without retiring the source. A second conversion would double-credit that money even with a new request's own idempotency protection.

**How to apply:** Serialize with wallet writers, reject unsettled work, bind confirmation to the saved rate and balance, and preserve fractional value by rounding up only to the smallest supported credit unit. Conversion does not authorize changing billing mode or enforcement.

**Why:** A mode switch after acceptance must neither add a second charge to reserved work nor remove the only charge from credits-funded work. Nested operations with their own wallet reservation must not inherit credit-debit authorization from their parent.

**How to apply:** Carry the funding decision through provider context copies and asynchronous job boundaries. Charge credits only for explicitly credit-funded work; retain legacy accounting for pipelines not migrated as a complete unit.