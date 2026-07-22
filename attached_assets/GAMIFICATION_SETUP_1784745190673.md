# KOKAO Gamification — integration guide

Quests + streaks + upgrade meter + referral credits, layered on your existing systems: rewards go through the credits ledger, toggles through the feature-flag kill switches, referrals through the promo-code engine, and per-plan config through a defaults-when-missing settings table that automatically covers plans you create later.

## Apply it (on top of the video-studio patch)

```bash
git am gamification.patch
pnpm --filter @workspace/db run push
```

Restart the app. No new dependencies, no secrets, no external services — everything runs on data KOKAO already records.

## What users see (AI Studio)

A single "Level up" strip at the top of AI Studio:

- **Quests** — six getting-started quests (brand kit, first caption, first image, first video, connect an account, schedule a post). Completion is verified server-side from real data; each has a Claim button that grants credits. Claimed quests disappear.
- **Streaks** — consecutive days (UTC) with at least one generation. Milestone chips at 3/7/14/30 days become claimable as the run reaches them; a broken streak re-arms the milestones.
- **Upgrade meter** — caption/image/video usage bars with a contextual nudge ("You're creating faster than your plan") and an Upgrade button. Only shows on plans with finite limits.
- **Invite & earn** — a dialog with the workspace's personal `REF-XXXXXXXX` code (minted on first open), what both sides earn, and signup/earnings stats. New users redeem it on the Billing page like any promo code.

## Admin controls

- **Overview tab → Feature controls**: four new platform-wide switches — Quests, Streaks, Referral Credits, Upgrade Progress Meter. Instant off for everyone.
- **Plans tab → "Gamification per plan"**: every plan in the catalog (including future custom plans, automatically) with its own four toggles, a reward multiplier (0–1000%, scales all quest/streak payouts), referrer/referee credit amounts, and a per-code redemption cap. "Reset to defaults" removes the customization. All changes are audit-logged.
- A mechanic shows for a tenant only when **both** its global switch and its plan toggle are on.

## How referrals work under the hood

A referral code is a real promo code (campaign `referral`, `ownerTenantId` set, audience "new users within 30 days", one redemption per workspace). Redeeming grants the friend the code's credits AND pays the referrer inside the same atomic transaction, sized by the referrer's current plan settings — so upgrading improves future referral earnings. Self-redemption is blocked, the referrer gets an in-app notification, and per-redemption referrer payouts are recorded on `promo_redemptions` for stats. All existing promo admin metrics count referrals automatically under the "referral" campaign.

## Safety properties

- Claims are idempotent behind a unique `(tenantId, key)` index — double-clicks and replays can never double-grant.
- Streak claim keys bind to the streak's start date, so stale keys from a broken streak are unclaimable.
- The server re-verifies every achievement at claim time; the client is never trusted.
- Every reward lands as an audited `credit_ledger` entry (`note: gamification:<key>` / `kind: referral_reward`).

## Verified

- Monorepo typecheck clean (api-server, web, mobile)
- API server: **1032/1032 tests** (new: quest/streak/multiplier/claim-idempotency, referral mint/self-redeem/payout/plan-disable)
- Web: **306/306**, mobile 149/149; spec lint + codegen drift clean
- `db push` applied cleanly (additive only)

## Defaults you may want to tune (Plans tab)

Referrer reward 5 captions + 3 images; friend gets 5 + 3; 25 redemptions per code; reward multiplier 100% on every plan. A sensible first move: set the multiplier to 0% or toggle quests/streaks off for Business (unlimited plans don't need credit rewards) and leave referrals on everywhere.
