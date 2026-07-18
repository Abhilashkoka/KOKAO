---
name: Razorpay billing invariants
description: Payment-verification and credit-ledger rules for the Razorpay billing module.
---

- **Never trust client or webhook payload state for money.** Both the interactive verify endpoints and the webhook backstop must re-fetch the canonical entity from Razorpay and require a FINAL state: orders must be `paid` (never `attempted`), subscriptions `active`/`authenticated`. The webhook `payment.captured` handler cross-checks the fetched order's purpose/tenantId/creditPackId/amount against the pack before crediting.
  **Why:** architect review flagged that accepting `attempted` orders and trusting `payment.notes` could grant credits for unsettled or mismatched payments.
  **How to apply:** any new billing path (refunds, upgrades, new gateways) must fetch-and-verify server-side before mutating balances or plans.
- **Ledger must reconcile with balance.** Credit balances are clamped at zero, so the ledger records the APPLIED delta (newBalance − oldBalance), not the requested delta. Grant flow: lock balance row FOR UPDATE, compute applied deltas, insert ledger (unique razorpay_order_id aborts duplicates), update balance — all in one transaction.
- Drizzle wraps pg errors: unique-violation dedupe must walk `error.cause` for code 23505 / the constraint name.
- Razorpay webhook tests: partially mock the lib (`vi.mock` with `importOriginal`) to stub only `fetchRazorpayOrder`, keeping real HMAC signature verification against a seeded webhook secret.
