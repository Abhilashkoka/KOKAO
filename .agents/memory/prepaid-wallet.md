---
name: Prepaid wallet billing
description: Rupee wallet funding rail — reserve/settle/refund lifecycle, GST handling, and how it coexists with quotas and unit credits.
---

# Prepaid wallet billing

- Second funding rail beside plan quotas and unit credits: `tenants.billingMode` (quota | wallet), with the `wallet` platform feature switch as a hard override kill switch (off = everyone on quota rail; no migration needed).
- Ledger discipline: `wallet_ledger` records the APPLIED delta and balance floors at zero, so SUM(ledger) always equals `wallet_balances`.
- GST is exclusive in-app and added exactly once at Razorpay order creation; verification trusts the order's own notes for the base/GST split (never current settings) and is idempotent per order id.
- Generations reserve an estimate BEFORE the provider call, then settle to real cost + platform fee. A model with no catalog price (or computed cost of 0) settles at the admin display rate flagged `estimated` — nothing generates for free. Background jobs persist the reservation (id, paise, units) on the job row so runners, cancels, and sweeps can settle or refund work that outlived the request.
- Video settle passes the ffprobe-duration-based catalog cost into `settleWallet` (actual + fee when known); patch originally always estimated for video — keep the real-cost wiring.

**Why:** money code must reconcile exactly and never charge twice or free; the reserve→settle pattern is the only way to bill jobs whose real cost is known only after completion.

**How to apply:** any new AI generation path that can spend wallet funds must reserve before the provider call, settle/refund on every terminal path (success, failure, cancel, sweep), and never call the provider without a persisted reservation.
