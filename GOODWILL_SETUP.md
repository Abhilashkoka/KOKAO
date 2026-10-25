# Goodwill fixes (T2) — setup

Patch T2 of the trust & billing spec: users don't pay for the AI's
mistakes, within limits you control.

- **1 free Smart Edit per video, up to 3 seconds.** Picture edits only
  (Change, Remove, Outfit, Re-shoot). Seconds above 3 are charged. New line
  (voice + lip sync) is always charged.
- **Free storyboard image redos: 1 per video** (admin-editable). Covers the
  topic-video **Redraw** and the Guided Story **Correct scene**.
- **Goodwill budget and alarm** in Admin → AI → Goodwill.

Built on `feat/trust-pricing` (T1) @ `07c438a`. Branch: `feat/goodwill-fixes`.

## Apply

```bash
git fetch origin && git checkout feat/goodwill-fixes
pnpm install
pnpm --filter @workspace/db run push     # adds the goodwill_settings table
pnpm run typecheck
```

Generated API clients are committed; codegen is not needed. If T1 is not
applied yet, its two `credit_meter_settings` columns arrive in the same push.

## How "free" works

Just before a free fix starts, the workspace is granted exactly the credits
the free part will cost (ledger kind `goodwill`, one-day expiry). The meter
then charges the fix as usual — granted credits are spent first — so every
provider call is still recorded at its real cost and all the existing refund
paths are unchanged. The balance only moves by the part that isn't free.

| Fix | Free part | Charged |
| --- | --- | --- |
| First picture Smart Edit on a video | Frame edits + first 3s of the clip | Seconds above 3 |
| Any later Smart Edit on that video (incl. Try again, after restoring a version) | — | All |
| New line edit | — | All |
| First storyboard image redo on a video | One image | — |
| Further redos | — | All |

Once per video is enforced by ledger idempotency keys
(`goodwill:smart-edit:<jobId>`, `goodwill:image-redo:<jobId>:<n>`) under a
per-workspace lock, so double clicks or two servers can't take it twice.

## What users see

- Smart Edit price line: *First 3s free · you pay ≈ 4 credits*, or *Free — first
  3s of this video's first edit are on us* when the whole edit fits.
- Storyboard buttons: **Redraw · free**, **Correct scene · free**,
  **Replace this preview · free** while a free redo is left.
- Credit history: *Free fix (on us)*.

## Admin → AI → Goodwill

| Setting | Default |
| --- | --- |
| On / off | On |
| Free storyboard image redos per video | 1 |
| Free Smart Edit seconds | 3 |
| Monthly goodwill budget per workspace | 50 credits |
| Daily alarm, all workspaces | 500 credits (0 = off) |

The card also shows goodwill credits today, this month and the number of free
fixes this month. Changes are audited (`goodwill_settings_change`).

**Set the budget against your rate card.** 50 credits is a placeholder: at
1 credit/second of video that is roughly 10 free 3-second edits a month per
workspace. Target goodwill under 5% of revenue.

The daily alarm notifies platform admins (in-app, push, email) at most once
per UTC day. Admins can mute it under notification type *Free-fix spending
alarm*.

## Rules worth knowing

- Only **credit-funded** workspaces (credits rail + meter in `enforce`) get
  free fixes. Quota and wallet workspaces are charged as before.
- If a free fix fails or never starts, its goodwill credits stay on the
  balance for a day and the failed spend is refunded as usual. Bounded by the
  per-video key and the monthly budget, and in the customer's favour.
- A Smart Edit regeneration no longer runs the generic topic-video preflight
  (which priced it as a 4-scene job); its parent route already checks the
  whole edit with the free part applied.
- Goodwill never blocks a fix: if the goodwill claim errors, the fix is simply
  charged in full.

## Tests

- `api-server/src/lib/goodwill.test.ts` (12): free-part math, a 5s edit paying
  for 2s, New line never free, once per video, N redos per video, monthly
  budget, off switch and non-credit workspaces, concurrent claims, settings
  validation, report, once-a-day alarm.
- Re-run and passing: `routes/videos.test.ts` (325), Smart Edit, guided story,
  credit/meter, notifications and admin suites (748 of 750; one order-dependent
  guided-cast case passes on rerun, one NVIDIA case needs DNS); web Smart Edit
  dialog, credit balance, spend guard, admin AI tab and Video Studio (201).
- `pnpm run typecheck` clean.
