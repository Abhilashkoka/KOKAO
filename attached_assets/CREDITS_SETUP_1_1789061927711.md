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
`credit_accounts`, `credit_account_ledger`, and `plan_settings.monthly_credits`.
Nothing existing is altered or dropped — the old quota, credit-pack and wallet
rails keep working untouched until you switch the meter to `enforce`.

## Go-live order

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

**3. Set plan allowances**, then run the migration dry run, read it, and apply.

**4. Switch to `enforce`.** Credits are debited before each provider call and
refunded if it fails.

Going straight to `enforce` charges from a rate card nobody has checked. The
switch is one dropdown in either direction, so rolling back is instant.

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
| Image generation | `lib/imageGeneration.ts` | `image` |
| Scene keyframes + retries | `lib/videoGen/topicVideo/characterScenes.ts` | `image` |
| Video generation, incl. failover | `lib/videoGen/index.ts` | `video` / `video_hd` |

Still to wrap: `textGen`, `imageEdit`, `asr`, voice cloning. Each is one
`meter()` call at the same boundary.

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
- **38 new tests**, all passing:
  - `creditAccounts.test.ts` (12) — bucket ordering, lazy expiry, idempotency,
    concurrent-spend safety, ledger/balance reconciliation
  - `creditEnforcement.test.ts` (14) — enforce debits, insufficient-balance
    refusal before the provider is called, refund on failure, operation-key
    idempotency, provider token capture, quote pricing, monthly grant
  - `meter.test.ts` (12) — fractional rates, retry counting, failed-call
    recording, pass-through, off mode, unpriced keys
- Full `api-server` suite before and after: **479 failures → 443**, +38 passing.
  No new failures. (Both runs carry ~450 pre-existing failures in a sandbox
  with no seeded dev database or external services.)

Verified against a clean Postgres 16 provisioned for this work, not your dev
database. `db push` adds tables and alters nothing, but run it against a
snapshot first.
