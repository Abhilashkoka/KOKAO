---
name: Invoice module
description: Tenant invoice issuance, gapless numbering, and idempotency rules for KOKAO billing.
---

- `recordInvoice` is best-effort (never fails the payment path) and idempotent on `(kind, refId)`. All idempotency + numbering happens INSIDE one tx that holds the invoice_settings singleton row FOR UPDATE: re-check existing → take seq → insert → bump counter. Never advance the counter outside that lock or losers burn numbers.
  **Why:** review found the earlier lock-then-onConflictDoNothing version skipped sequence numbers under races; GST invoices must be gapless per Indian FY (Apr–Mar).
- `invoice_settings` is a hard DB singleton via a unique index on a constant `singleton` boolean; seed with onConflictDoNothing then re-select.
- Plan invoices are keyed per paid CYCLE, not per payment: refId = `<subscriptionId>:<cycleEndISO|activation>` computed from the SAME source in the browser verify route and the webhook (Razorpay `current_end`, Cashfree `current_cycle.cycle_end_time`). Any new paid path must reuse the exact key or one charge gets two invoices.
- Cashfree renewals only arrive via webhook — the subscription webhook handler must record the invoice (browser verify never fires for renewals).
- No GST split for credit packs/plans → base=total, gst 0, PDF says "inclusive of taxes"; wallet top-ups carry the real split from order notes/tags.
- Buyer snapshot: per-tenant billing_profiles (owner-editable in Billing settings) falls back to tenant name/email; seller snapshot from superadmin invoice settings (credentials tab card). Changes affect future invoices only.
