# Honest pricing (T1) — setup

Patch T1 of the trust & billing spec: no credit leaves a balance without the
user having seen a number first, users can see what their credits buy, every
video shows quoted vs charged, and a paid-but-missing purchase can be
restored in one tap.

Built on `feat/guided-comedy-product-share` @ `cd3df20`.

## Apply

The branch is on GitHub (`feat/trust-pricing`). In Replit:

```bash
git fetch origin && git checkout feat/trust-pricing
pnpm install
pnpm --filter @workspace/db run push     # adds 2 nullable columns
pnpm run typecheck
```

Generated API clients are committed, so codegen is not needed.

`db push` adds `credit_meter_settings.confirm_above_credits` and
`credit_meter_settings.confirm_above_percent`. Both are nullable; null means
the built-in default. Nothing else is altered.

## What changed

| Area | What the user sees | Where |
| --- | --- | --- |
| Video Studio | Itemised credit quote above **Generate**; confirm dialog for big jobs | `video-studio.tsx`, `spend-guard.tsx` |
| Guided Story | Quote for the final render above the final button, priced from the approved script; confirm dialog for big jobs | `guided-story-workflow.tsx`, `GET /credits/quote?action=guided_story&draftId=` |
| Finished video | *Quoted X · Charged Y credits*, refunds and per-line breakdown; flags > 15% over quote | `video-credit-receipt.tsx`, `GET /credits/receipts/video-jobs/:jobId` |
| Billing → Credits | *≈ N videos of 30s, or ≈ M images* under the balance | `credit-balance.tsx` |
| Billing → Plans | *2,000 credits every month · ≈ N videos of 30s a month* on credits plans | `billing-settings.tsx` |
| Billing → Restore purchases | Unfinished Cashfree payments listed with **Check payment**; manual order-ID restore | `restore-purchases.tsx`, `pending-payments.ts` |
| Admin → AI | **Spend guard** card: confirm above N credits / N% of balance | `spend-guard-card.tsx`, `/admin/credit-spend-guard` |

Quote lines now read in plain words ("Scene images", "Voice (per second)")
instead of rate keys.

## Fixed along the way

**Guided Story preflight priced every story as 5 seconds and 4 scenes.** The
guided enqueue sends no duration or paragraph count, so the generic preflight
fell back to its defaults. It now uses the approved script's runtime, scene
count and spoken lines — the same numbers the user is shown.

## Rules worth knowing

- **Spend guard defaults:** confirm above **100 credits** or above **25%** of
  the balance. 0 switches a threshold off. Only applies when the workspace is
  credit-funded (credits rail + meter in `enforce`).
- **The guard never creates the settings row.** The production saved-rate
  bootstrap refuses to start over an unreviewed row, so saving the guard
  before the rate card exists returns 409 *Save the credit rate card once*.
- **Quote frozen on the job:** `options.creditQuote` is written at enqueue
  (not for slideshows, which make no AI calls). Retries of the same job keep
  it, so a retry shows as *charged above quote* rather than a new quote. Jobs
  from before this change show *Charged* only.
- **Receipt scope:** the parent job's own ledger rows. Smart Edit children are
  separate jobs and are not folded in yet.
- **Restore purchases** calls the existing `verify-purchase` /
  `verify-subscription` endpoints. The server re-fetches the order from
  Cashfree, checks it belongs to this workspace and is PAID, and credits it
  once (ledger idempotency key `pack:cf:<orderId>`). Pressing it twice, or after
  the webhook already landed, never adds credits twice. Razorpay packs need the
  payment signature, so they still rely on the webhook.
- **Remembered payments** live in the browser (`localStorage`, 30 days). It is
  a convenience only; blocked storage just hides the list.

## One setting to check (not code)

**Same email, different sign-in method.** KOKAO makes one workspace per Clerk
user. In the Clerk dashboard, keep **account linking by verified email** on
(Clerk's default), so someone who paid with email OTP and later signs in with
Google lands in the same user, workspace and balance.

## Not in T1 (by design)

- Price on every other paid button (cover, layers, voice) — Video Studio and
  Guided Story carry most of the spend; the rest can reuse `CreditQuoteSummary`
  and `useSpendConfirmation`.
- Public pricing page "≈ N videos" line — the quote endpoint is
  authenticated; needs a small public rate endpoint.
- Free fixes and the AI Error Guarantee — patches T2 and T3.

## Tests

- `api-server/src/routes/credits.trust.test.ts` (11): spend-guard defaults,
  save, range checks, never creating the settings row, the confirm rule,
  guided quote from the script, cross-tenant 404s, receipt netting and variance.
- `socialforge/src/components/spend-guard.test.tsx` (7) and
  `restore-purchases.test.tsx` (5).
- Re-run and passing: all `lib/credit*`, `meter`, `productionCreditBootstrap`,
  `routes/credits`, `routes/admin*` (303), `routes/videos.test.ts` +
  `guidedStory.test.ts` (393), Video Studio / Studio / Quick Create pages (241),
  billing, credit-balance, guided workflow and admin AI tab (131).
- One pre-existing sandbox failure, unrelated:
  `admin.modelPricingSync` NVIDIA self-hosted case needs DNS.
- `pnpm run typecheck` clean across all projects.
