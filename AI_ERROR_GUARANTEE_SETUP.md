# AI Error Guarantee (T3) — setup

Patch T3 of the trust & billing spec. When a finished video is wrong because
of the AI, the user gets credits back for the part that's wrong. Fixing it
comes first; a refund is the fallback.

Built on `feat/goodwill-fixes` (T2) @ `d4aec4d`. Branch: `feat/ai-error-guarantee`.

> **Ships switched OFF.** It changes your terms of sale. Turn it on in
> Admin → AI → AI Error Guarantee only after the terms clause below is
> reviewed and live on the Terms page.

## Apply

```bash
git fetch origin && git checkout feat/ai-error-guarantee
pnpm install
pnpm --filter @workspace/db run push     # adds ai_error_claims + ai_error_guarantee_settings
pnpm run typecheck
```

This brings T1 and T2 with it. Generated API clients are committed.

## How it works

1. On a finished video the user taps **Report AI error** (shown only while the
   guarantee is on, the video is inside the claim window, and the workspace
   pays in credits).
2. **Fix first.** The dialog offers Smart Edit — *Fix it free* when the video's
   free 3 seconds are still unused. Most mistakes end here.
3. **Or claim.** The user picks what went wrong, marks where (play to the spot →
   *Start here* / *End here*), adds a note.
4. **Refund = what the video cost × the share marked.** A 5s problem in a 20s
   video that cost 40 credits refunds 10. "What it cost" is the video's own
   ledger net of earlier refunds, so a refund can never exceed what was paid.
5. **Auto-approved** straight away when all of these hold; otherwise it waits
   for an admin:
   - category is objective: product/outfit changed, script line missed,
     wrong person, garbled on-screen text ("Something else" always waits);
   - the marked part is at most 50% of the video;
   - the workspace has fewer than 2 auto-approved claims this month.
6. Refunds go to the **never-expiring** purchased bucket as an ordinary
   refund, tagged to the video — the receipt shows *AI error refund*.

One claim per video, ever (a rejected claim can't be refiled).

## Admin → AI → AI Error Guarantee

| Setting | Default |
| --- | --- |
| On / off | **Off** |
| Claim window | 7 days from creating the video |
| Auto-approve per workspace per month | 2 |
| Auto-approve up to | 50% of the video |

Below the settings: this month's claims, credits refunded, and claims **by
category** — the list to fix prompts and models against. Then the queue: each
pending claim plays the marked part, with the suggested refund prefilled.

- **Approve** refunds the amount in the box (capped at what the video cost).
- **Reject** needs a note; the user sees it.
- Both are audited (`ai_error_claim_decision`) and notify the user (in-app +
  push, type *AI error claim decisions*).

## Draft terms clause (for your lawyer)

Not legal advice — a starting point to review alongside the existing legal pack.
It narrows the current "the user bears the cost of every generation" rule;
everything else in the terms stays.

> **AI Error Guarantee.** Generations are charged whether or not you are
> satisfied with the result, except as set out here. If, within seven (7) days
> of creating a video, you report that part of it is objectively incorrect
> because of the AI — your product or outfit was altered, an approved script
> line was omitted or changed, a different person or face appears, or
> on-screen text is illegible — we will, at our option, help you correct it or
> credit back to your account the proportion of the credits charged for that
> video that corresponds to the affected portion. Refunds are made in credits
> only, are not exchangeable for cash, and are limited to one claim per video.
> Claims for changes of mind, subjective preferences, or content you approved
> at the storyboard stage are not covered. We may review any claim and decline
> claims we reasonably believe are not covered or are made in bad faith. This
> guarantee applies only to workspaces on credit plans and may be changed or
> withdrawn for future generations with notice.

## Rules worth knowing

- **Not for quota/wallet workspaces.** They see no button; refunds are in
  credits. Handle those by hand with Admin → credit grant.
- **Smart Edit child jobs** aren't claimable on their own; claims are on the
  video the user sees. The refund share is computed against the parent video's
  own charges.
- The claim window counts from when the video was created.
- Turning the guarantee off hides the button but keeps the queue and history.

## Tests

- `api-server/src/lib/aiErrorClaims.test.ts` (12): refund math, settings
  validation, off by default, auto-approve and refund into the receipt, one
  claim per video, "other"/big range/monthly limit go to review, note and
  range checks, claim window, non-credit workspaces, nothing-charged videos,
  admin approve with cap, reject needs a reason, report by category.
- `socialforge/src/components/report-ai-error.test.tsx` (5): hidden when not
  eligible, fix-first, files the marked range, range check, shows outcome.
- Re-run and passing: video routes, goodwill, credit, notification, admin and
  credits suites (669 of 670 — the one is the NVIDIA case that needs DNS); web
  Video Studio, admin AI tab and credit balance (196).
- `pnpm run typecheck` clean.
