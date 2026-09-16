# Credit system — setup

Moves KOKAO off per-plan quotas and onto a single credit balance: a superadmin
rate card, a meter at the provider boundary, per-workspace balances with
monthly allowances, enforcement, a pre-render quote, and a migration for
existing workspaces.

Built against `feat/prompt-kit-script-variants` @ `5cf57a9c`.

## Apply

```bash
git am -3 < credits-system.patch                    # -3 does a three-way merge
pnpm install
pnpm --filter @workspace/api-spec run codegen       # REQUIRED: builds the client
pnpm --filter @workspace/db run push                # adds 5 tables + 1 column
pnpm run typecheck
```

**Codegen is not optional.** The patch carries the OpenAPI spec but not the
files orval generates from it. Generated output churns on every regeneration
and is the most conflict-prone thing you can put in a diff; running codegen
produces those files locally, conflict-free.

`db push` adds `credit_rates`, `credit_meter_settings`, `credit_meter_events`,
`credit_accounts`, `credit_account_ledger`, `plan_settings.monthly_credits` and
`credit_packs.credits`. Nothing existing is altered or dropped — the old quota,
credit-pack and wallet rails keep working untouched until you switch the meter
to `enforce`.

## Go-live order

### Development saved-rate activation

Development deductions can be enabled after testing the saved rate card, insufficient
balance handling, failure refunds, operation replay, and billing-rail isolation.
This is a separate authorization from production invoice reconciliation: it verifies
customer charges against configured prices, not provider costs or profitability.

The explicit development-only setting is `CREDIT_ENFORCEMENT_DEV=1`; it requires
`NODE_ENV=development` and is denied on a Replit deployment. The meter must also
be set to `enforce` through its guarded settings service. Keep the setting scoped
to development.

Existing credit balances and deferred legacy wallet estimates are not modified
by activation. Explicit active zero-priced actions remain free; missing or invalid
billable rates must fail before provider dispatch.

### Production saved-rate activation

The user-approved production customer policy is a separate, explicit
saved-rate rollout. It does **not** assert that provider invoices have been
verified: `CREDIT_RECONCILIATION_GATE` remains `no-go` until that evidence is
available. It authorizes only the customer credit deductions described by the
reviewed card.

The deployment must set all of the following before the server starts:

```text
NODE_ENV=production
REPLIT_DEPLOYMENT=1
CREDIT_ENFORCEMENT_PROD=saved-rates-v1
CREDIT_PRODUCTION_ROLLOUT_JSON=<the reviewed JSON manifest>
```

The bootstrap refuses to start before binding the HTTP port when the manifest
is missing, malformed, incomplete, has a different version, contains guessed
rate keys, or has an incomplete plan list. The exact JSON shape is:

```json
{
  "rolloutVersion": "saved-rates-v1",
  "mode": "enforce",
  "creditPricePaise": 2000,
  "rates": [
    {
      "key": "<one reviewed supported key>",
      "label": "<reviewed label>",
      "unit": "item | second",
      "credits": "<reviewed non-negative number>",
      "active": true,
      "sortOrder": "<reviewed non-negative integer>",
      "notes": "<reviewed string or null>"
    }
  ],
  "plans": [
    {
      "id": "<reviewed plan id>",
      "billingMode": "credits",
      "monthlyCredits": "<reviewed non-negative integer>"
    }
  ]
}
```

`creditPricePaise` is an explicitly reviewed positive integer for the fresh
production settings row; it prevents a later legacy price read from falling
back to the development/application default. The bootstrap audit marker uses
the non-tenant deployment operator (`actorTenantId = 0`), with
`principal: "deployment-owner"` and the trusted deployment environment as the
authorization boundary; it never impersonates an admin or customer.

`rates` must contain exactly the supported saved keys (`video`, `video_hd`,
`image`, `image_edit`, `caption`, `voice`, `lipsync`, and `transcription`),
with every row active for enforce mode. `plans` must contain unique plan ids.
The application supplies no rate or allowance defaults; the deployment owner
must replace every angle-bracketed value with an explicitly reviewed value.

The first boot takes a transaction-scoped advisory lock, confirms
`credit_meter_settings` and `credit_rates` are empty, inserts the manifest
card in `enforce`, applies the reviewed allowance and `credits` billing mode
to the named existing plan rows, and switches existing tenants on those plans
to the `credits` rail. It writes one `credit_rates_change` audit marker with
the rollout version. No credit accounts, balances, wallets, usage rows,
ledgers, history, grants, repricing, or queued/old jobs are changed. Existing
jobs keep their frozen legacy funding; only future ordinary usage sees the
new rail and allowances.

On later boots, the marker makes the bootstrap an idempotent no-op. It never
resets a mode, rate, allowance, or tenant after an administrator changes one.
An unmarked existing settings/rate row is treated as an unreviewed conflict and
fails closed rather than being overwritten. There is no production DDL or
migration script for this activation.

### Provider invoice verdict

The meter has three modes, and the order matters more than anything else here.

**1. Land on `shadow` (the default).** Every provider call is priced against
the rate card and recorded; nobody is charged. Within days you have the first
true per-job cost picture KOKAO has produced — retries and failed renders
included.

**2. Reconcile.** Admin → AI → *What the meter recorded*. Compare
`totalProviderUsd` against the Atlas invoice for the same window.

- **They meet** → the rate card is right.
- **Invoice is higher** → an unmetered call path remains. Find it first.

Your own `reports/atlas-audit/findings.csv` already flags this: job #69771 had
4 completed Atlas tasks and only 2 KOKAO cost rows. That is the gap this meter
is built to close, and shadow mode is how you confirm it closed.

**3. Compare the full shadow window** with the provider's invoice and record
any unmetered call paths. This evidence remains useful for the provider-cost
decision even though it is not a prerequisite for the separately authorized
customer saved-rate rollout.

**4. Switch to `enforce`.** In production, the reviewed bootstrap above is the
only deployment path for the initial saved card and plan/tenant rail switch.
Credits are debited before each provider call and refunded if it fails.

The saved-rate rollout is a customer charging authorization, not an invoice
claim. Continue the invoice reconciliation work independently; the invoice
verdict is still no-go until provider evidence is verified. The in-app switch
can still turn the meter off or back to shadow after activation, but a later
boot never silently turns it back on.

## What the meter catches that nothing else did

Funding was reserved at the **route**, per user-facing action. Money is spent
at the **provider**, deep inside the pipeline. Everything between was invisible:

| Spend | Where | Recorded before |
|---|---|---|
| Scene keyframes inside a video job | `characterScenes.ts` | no |
| Keyframe retries (`"retrying once"`) | `characterScenes.ts` | no |
| Distinctness reruns (`"regenerating once"`) | `characterScenes.ts` | no |
| Renders a QA gate later rejects | `qaGate.ts` | no |
| Video model seconds | `jobRunner.ts` | yes |

`recordUsage()` only fires on success, so a render the provider billed and then
failed left no trace. The meter wraps the provider call instead: a retry counts
as two, and a failure still records.

## Provider tokens, not just seconds

`credit_meter_events` stores `provider_tokens` and `provider_cost_micro_usd`
alongside the rate-card price, because **Atlas bills Seedance by output token,
not by second**. Your audit data shows why that matters:

| Bucket | Requests | Tokens/request | $/request |
|---|---|---|---|
| reference-to-video (8 Sep) | 1 | 38,830 | $0.54 |
| reference-to-video (9 Sep) | 16 | 324,000 | **$3.94** |

Same model, same provider — **8.3× the tokens per request**, and 84% of your
Atlas spend sits in the expensive profile. Recording only duration hides that
entirely. Once shadow mode has a week of data, group the report by model and
look at the token column: the cheap profile is a configuration you already
produced once.

## Plans

A plan is what makes credits arrive. Three fields carry it:

**Credits / month** — the allowance granted at the start of every paid period.
0 means the plan carries no allowance and the workspace buys its own. The
built-in plans ship at 0 deliberately: what an allowance is worth depends on
the rate card, so it is a pricing decision rather than a number this patch
invents on your behalf.

Underneath the field is what that number actually buys — *"About 500s of
video · 166 images · 2,500 captions at the current rate card"* — read live
from the rate card, so changing a rate re-prices every plan in front of you.
The wording is deliberate: it is whichever mix they use, not all three.

**Billing mode** — now three rails, not two:

| Mode | Funds generation from |
|---|---|
| Monthly quota | Counted per-action allowances, plus legacy caption/image packs |
| Prepaid wallet | A rupee balance, charged per generation |
| **Credits** | One credit balance, metered at the provider |

**The AI quota fields disappear on a credits plan** — captions, images and
videos per month. They are kept, not cleared: move the plan back to quota and
they are exactly as they were. Brand kits and scheduled posts stay on every
plan, because credits do not fund them.

A workspace is only really on credits when **both** its plan says credits and
the meter says `enforce`. Moving a plan to credits during shadow mode changes
nothing for the people on it — which is the point, because otherwise a plan on
credits plus a meter that is only recording would reserve nothing at the route
and charge nothing at the provider: unlimited free generation, arrived at by
two settings that each looked harmless.

That same pairing is what the user-facing UI keys off. `GET /credits` returns
`funded`, the server's own answer to "is this balance what pays for my work",
so the dashboard, settings and studio show a credit balance exactly when
credits are what is being spent, and quota meters the rest of the time. One
dropdown switches the whole experience, in both directions.

## Free plans

Paid plans get their allowance from `subscription.charged` or an entitled
Cashfree cycle. A free plan has no gateway, no subscription and no period — so
without a second path, a free workspace would hold a plan advertising an
allowance, a balance stuck at zero, and a first encounter with the credit
system that consists of being refused.

`grantUnbilledPlanCredits` covers them: calendar-month periods, granted lazily
on the balance read, keyed `plan:<tenantId>:<YYYY-MM>` so repeat calls are
free. The read is deliberately narrower than "no online price": it requires
the workspace to be explicitly on the **credits** rail, the release-gated meter
to be enforcing, no current gateway entitlement, and an already-existing
credit account. A null catalog price is not enough — manual-only plans can
still have a live subscription, and a read must never create the account
marker used by migration. Existing paid-period and migration receipts also
block an overlapping calendar-period allowance.

No cron, and a workspace that never opens the app is never granted credits it
was not going to spend. Until migration has created the account, a balance
read is side-effect free.

## Where it lives

**Admin → AI tab**

- **Credit rate card** — what each action costs, plus the meter mode.
- **What the meter recorded** — calls, failures, credits, provider tokens, $.
- **Migrate workspaces to credits** — dry run, then apply.

**Header** — a credit balance pill for every workspace (hidden while the meter
is off).

## The default rate card

Seeded on first read, anchored at **1 credit = 1 second of standard-resolution
video**. These are a starting point, not a recommendation.

| Key | Action | Per | Credits |
|---|---|---|---|
| `video` | Video generation | second | 1 |
| `video_hd` | Video generation (720p+) | second | 1.5 |
| `image` | Image generation | item | 3 |
| `image_edit` | Image edit | item | 3 |
| `caption` | Caption / text generation | item | 0.2 |
| `voice` | Voice / narration | second | 0.1 |
| `lipsync` | Lip sync | second | 2 |
| `transcription` | Transcription (ASR) | second | 0.05 |

Stored as integer milli-credits, so `0.2` is exact rather than a float.

## Balances

Two buckets per workspace, because they behave differently:

- **purchased** — paid for. **Never expire.** Expiring money someone handed
  over reads as theft and buys nothing; the margin is already in the price.
- **granted** — plan allowance, signup bonus, promo, admin top-up. **Expire**
  (default 90 days, `CREDIT_GRANT_EXPIRY_DAYS`).

Spending draws from **granted first**, so an allowance is used before it lapses
rather than wasted while purchased credits drain. Refunds land in **purchased**,
so a refund for a failure that was never the customer's fault never carries a
deadline. Expiry is lazy — applied inside the row lock on any read or write, so
there is no cron and no drift.

## Monthly allowances

Set `monthly_credits` per plan. On `subscription.charged` (Razorpay) or an
entitled cycle (Cashfree), the allowance is granted with an idempotency key of
`plan:<tenantId>:<periodEnd>` — the same cycle identity the invoice already
uses. Gateways redeliver webhooks routinely, and a double grant is free money;
the ledger's unique index makes a replay a no-op.

A grant failure never fails the webhook. A non-2xx would make the gateway retry
a payment that already succeeded.

## Buying credits

Credits enter a balance four ways: a plan allowance on renewal, a **pack
purchase**, a superadmin grant, and the migration.

Packs reuse the existing purchase flow rather than a parallel one — same
gateway machinery, same signature verification, same amount cross-check, same
invoice. Set `credits` on a pack in **Admin → Plans → Credit packs** and it
tops up the balance; the three legacy buckets keep working beside it, so one
pack list serves both rails through the changeover.

The gateway order id is the idempotency key. The browser verify path and the
webhook backstop both fire on every purchase — they race by design — so
whichever lands first credits and the other is a no-op.

## Running out of credits

Two guards, one answer.

**Before the job**, `refuseIfShortOfCredits` quotes the whole thing and returns
402 if the balance cannot cover it. The meter would refuse an individual call
anyway, but discovering that at scene three leaves a half-rendered job and a
user with no idea what happened.

**During the job**, the meter's own refusal maps to the identical 402 shape, so
a shortfall nobody could predict — a retry, a scene the plan missed — reaches
the UI looking the same as one that was.

Both bodies carry the figures:

```json
{ "code": "insufficient_credits", "required": 32, "available": 5, "shortfall": 27 }
```

`InsufficientCreditsDialog` renders that as "this needs 32 credits and you have
5" with a top-up button. "Insufficient credits" without those two numbers tells
someone they have a problem without telling them how big it is.

Both fail open: a preflight that errors lets the job through, because the
meter's per-call check still guards the money.

## Adding a cost centre

1. Add a row in the rate card with a new key (lowercase, digits, underscores).
2. Wrap the provider call:

```ts
import { meter } from "../lib/meter";

const result = await meter(
  { tenantId, refKind: "videoJob", refId: String(jobId), operationKey },
  "lipsync",
  durationSec,                      // seconds, or 1 for a per-item rate
  () => provider.generate(input),
  (r) => ({ tokens: r.tokens, usd: r.actualUsd }),   // optional
);
```

Passing `null` instead of a context means "not billable to a workspace" — a
superadmin playground run, a health probe. The parameter is required, so that
is an explicit choice at the call site rather than something a new feature can
quietly forget.

`operationKey` makes the debit idempotent: a settle replayed after a crash
charges once.

## Wired so far

| Chokepoint | File | Key |
|---|---|---|
| Route funding gate | `routes/ai.ts` (`reserveFunding`) | — |
| Image generation | `lib/imageGeneration.ts` | `image` |
| Scene keyframes + retries | `lib/videoGen/topicVideo/characterScenes.ts` | `image` |
| Video generation, incl. failover | `lib/videoGen/index.ts` | `video` / `video_hd` |
| Image edit | `lib/imageEdit.ts` | `image_edit` |
| Transcription | `lib/asr/index.ts` | `transcription` |

Text generation is metered at the common text-client boundary using the saved
`caption` rate. Cloned voice creation and speech use the `voice` rate; stock
and localized narration are also wrapped. Multi-stage callers must carry the
owning job's frozen funding context and distinct stage/line operation identities.
Configured rates, not the historical examples in this document, determine charges.

`reserveFunding` is the one that keeps the rails from double-charging: a
credit-funded workspace reserves **nothing** at the route, because the meter
debits at the provider boundary, which is the only place that knows what the
call actually cost. Reserving again at the route would charge twice for one
generation and refuse work the balance could afford. Those usage rows are
written with `funding: "credits"` and excluded from quota counting.

ASR takes `meterTenantId` and `durationSec` on its input; pass them from
callers that generate on behalf of a workspace. `/ai/transcribe` still runs
unmetered by design — it is a dictation button, not a billable generation.

## Migration

`GET /admin/credit-migration` is a dry run that writes nothing — always read it
first. It converts:

- **quota** workspaces → their plan's allowance for the current period
- **credit-pack** workspaces → each bucket at what that generation now costs
- **wallet** workspaces → rupee balance ÷ credit price (`CREDIT_PRICE_PAISE`)

Conversion **rounds up** and lands in the **never-expiring** bucket. These
people bought under different terms; attaching a new deadline after the fact
would be changing the deal. Idempotent per workspace, so a partial run can
simply be repeated.

## Safety properties

- The meter **never changes the outcome of a wrapped call**. Metering errors
  are logged and swallowed; provider results return and provider errors rethrow
  exactly as before.
- A failed mode lookup falls through to running unmetered rather than blocking
  a generation.
- In `enforce`, the debit happens **before** the provider call, so two
  concurrent generations cannot both spend the last credit.
- Balance mutations hold `SELECT … FOR UPDATE`; the ledger always sums to the
  balance.
- Mode changes take effect immediately, both directions.

## Verification

- `pnpm run typecheck` — clean across all five projects.
- **57 new tests**, all passing:
  - `creditPlanMapping.test.ts` (10) — the allowance read off a plan row, the
    catalog's deliberate zero, the credits rail refusing to fund anything
    while the meter only records, quota/wallet workspaces left alone, and the
    free-plan grant: once per calendar month, never for a priced plan
  - `creditAccounts.test.ts` (12) — bucket ordering, lazy expiry, idempotency,
    concurrent-spend safety, ledger/balance reconciliation
  - `creditEnforcement.test.ts` (14) — enforce debits, insufficient-balance
    refusal before the provider is called, refund on failure, operation-key
    idempotency, provider token capture, quote pricing, monthly grant
  - `meter.test.ts` (12) — fractional rates, retry counting, failed-call
    recording, pass-through, off mode, unpriced keys
  - `creditTopup.test.ts` (9) — pack purchase into the non-expiring bucket,
    verify/webhook race credited once, preflight refusal with figures, 402
    mapping
- Full `api-server` suite before and after, with a complete test environment,
  compared by failing-test NAME rather than by count: **zero new failures**.
  Raw counts drift between runs (98 / 100 / 96 / 102 across four runs) because
  a handful of suites are flaky in a sandbox with no seeded dev database or
  external services — `bytePlusIdentityCleanup` and two `videos` cases move on
  their own. The name-level diff is the honest signal, and it is empty.
- Full `socialforge` suite: **1,085 passing, 0 failing** across 100 files,
  with the dashboard, settings, studio and plan-editor changes in place.
- The credit-pack webhook tests — including "credits a pack on a PAID order and
  dedupes redeliveries" — pass with the new top-up wiring in place.

Verified against a clean Postgres 16 provisioned for this work, not your dev
database. `db push` adds tables and alters nothing, but run it against a
snapshot first.
