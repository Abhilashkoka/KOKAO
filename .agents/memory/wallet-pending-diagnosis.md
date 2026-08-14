---
name: Wallet pending-price diagnosis & true-up retry
description: How the "Needs pricing" banner classifies stuck estimated charges and how true-ups retry
---

The admin "Needs pricing" list is driven by estimated ledger rows without `trueUpAt`, NOT by the catalog. Each pending group is diagnosed against the catalog (same findPrice rules incl. model-only provider fallback) into reasons: `no_price`, `price_incomplete`, `no_fx_rate`, `missing_usage`, `not_reconciled`.

**Why:** in prod, models WITH catalog prices sat on the banner forever because true-up only ran on price save (fire-and-forget) and rows with no token usage / no FX rate can never reconcile — blaming "no catalog price" was wrong and unactionable.

**How to apply:**
- True-ups now run on boot AND on a periodic interval (`TRUE_UP_RETRY_INTERVAL_MS`, overlap-guarded), plus a manual per-model reconcile endpoint that returns settled/remaining with a fresh diagnosis.
- Text (and token-only image) prices can NEVER reconcile charges lacking recorded token usage — the honest state is `missing_usage`, not a retry.
- Reason classification must stay in lockstep with the cost calculators' price-field requirements (text: token pair; image: per-image or token pair; video: per-second or per-video).
