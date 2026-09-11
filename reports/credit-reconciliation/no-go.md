# Shadow credit reconciliation: NO-GO

Assessment date: 2026-09-11.

**Decision: do not enable enforcement. Reconciliation is incomplete.**
This report does not certify rates, quantities, successful-call coverage, or paid-failure coverage.

## Evidence available

A read-only production query against `information_schema.tables` for public
tables named `credit%` returned only `credit_balances`, `credit_ledger`, and
`credit_packs`. The production shadow event, rate-card, and meter-setting tables
were absent at inspection. Development/test events cannot substitute for a
complete live billing window.

No matching provider invoice/statement exports were found in the workspace.
The existing `reports/atlas-audit/provider-cost-buckets.csv` is a partial
provider-cost audit, not a reconciled shadow ledger or complete invoice:

| Provider | Model | Dates | Requests | Provider USD | Unmapped requests | Unmapped USD |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Atlas | bytedance/seedance-2.5/text-to-video | Sep 8 | 2 | 1.080251 | 2 | 1.080251 |
| Atlas | bytedance/seedance-2.5/image-to-video | Sep 8 | 3 | 10.722936 | 0 | 0 |
| Atlas | bytedance/seedance-2.5/reference-to-video | Sep 8–9 | 17 | 63.619011 | 1 | 0.540125 |
| Total | | | 22 | 75.422198 | 3 | 1.620376 |

September 9 is explicitly partial. These request counts must not be relabeled
as successful calls or paid failures: this file does not classify them.
Rate-key attribution and shadow credit totals are unavailable for this period.
The source audit also records missing local cost rows; neither missing receipt
coverage nor unmapped spend is an accepted variance.

## Unresolved approval requirements

- Collect a complete, closed live shadow billing window with start/end timestamps
  and timezone matching each provider's invoice/account scope.
- Obtain invoices and detailed usage exports for every provider used in that window,
  including billed failed attempts, retries, discounts, tax and refunds.
- Join durable attempt receipts to provider usage, then group by provider, model,
  rate key and success/paid-failure status. Compare counts, quantities, provider
  currency amounts and shadow credits separately. Credits are not USD.
- Enumerate and resolve every unpriced key and missing quantity/receipt; do not
  replace unknown values with zero or silently reprice historical snapshots.
- Explain every provider-specific variance with evidence, distinguishing timing,
  unit rounding, invoice adjustments and actual metering/rate defects.
- Record a reviewed go/no-go decision with the exact window, rate snapshots and
  evidence references. No go decision is possible from the available evidence.

## Automatic protection

The server's explicit release gate remains no-go. Requests to save enforce mode
return HTTP 409 before changing the rate card; direct setter calls reject too.
A stored enforce setting is treated as shadow at runtime. There is no environment
override. Off and shadow remain available.

This is a conservative release lock, not an automated invoice-ingestion or
approval system. Removing it requires a separately reviewed code change backed by
the completed reconciliation above. These workspace changes do not deploy the
meter or alter the production schema/settings.