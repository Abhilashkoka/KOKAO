# Storyboard review — see every shot before you pay for the render

`storyboard-review.patch` · apply after `character-uniformity.patch` (`655a499`)

## Apply

```bash
git apply storyboard-review.patch
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run push
pnpm -w run typecheck
pnpm --filter @workspace/api-server run test src/routes/videos.test.ts src/lib/videoGen/videoJobSweep.test.ts
```

Unlike the last two patches, this one is not code-only. It adds three columns to
`video_generations` and four endpoints to the contract, so **`push` and `codegen`
are both required** — skip either and the server will typecheck against
generated files that do not describe the routes it now serves. The generated
output is included in the patch, so `codegen` should be a no-op that confirms
your orval version agrees with mine; if it produces a diff, commit the diff
rather than the version I shipped.

`push` adds `funding`, `storyboard` and `storyboard_expires_at`. All three are
nullable, nothing is dropped, and existing rows are untouched — the new
`awaiting_review` status is a plain string in a `text` column, so there is no
enum to migrate.

## What it does

A topic video with generated visuals — character scenes or AI b-roll — used to
run start to finish with nothing to look at in between. You typed a topic,
waited two to twenty-five minutes depending on the mode, and only then found out
whether the shots the model imagined were the shots you had in mind. If one
scene missed, there was no way to fix that scene; the whole video was spent.

Those jobs now stop halfway. The cheap half runs first — write the script, voice
the narration, group it into scenes, then generate one still per scene — and the
job parks in `awaiting_review` with the plan stored on its own row. The studio
draws every shot as a card: the still, the narration line it plays under, its
length, and the prompt in an editable box. You reword any prompt, redraw any
still, then press **Render this storyboard**. Only then does the expensive half
run: image-to-video per scene for character mode, or the Ken Burns encode for
b-roll. Discarding costs nothing, and a plan nobody approves is dropped after a
day with its reservation returned.

The thing that makes this cheap rather than merely nice is where the cut falls.
The stills on the plan are not throwaway thumbnails — they are the exact frames
the render animates. So approving a reviewed video generates no image twice, and
the prompt edits and redraws in between are genuinely unbilled. Redraws are
capped at two per scene, which is enough to fix a bad prompt without turning an
authenticated image generator into an open tap.

The toggle is on by default, in the topic options, and only appears for the two
modes that have prompts worth reviewing. An older client that has never heard of
storyboards gets one anyway, because the request schema defaults the flag to
true; a client that sends `false` gets the old straight-through behaviour.

## Tests

`pnpm --filter @workspace/api-server exec vitest run` is 1463 passing tests
across 115 files, up from 1444 across 114. Nineteen are new: sixteen in
`src/routes/videos.test.ts` and three in the new
`src/lib/videoGen/videoJobSweep.test.ts`.

Every new assertion was checked by breaking the source it covers and confirming
the test failed, then restoring it. The mutations, in order:

- Editing a prompt: made the PATCH ignore the edit; made it apply the first
  edit to every scene; dropped the `.trim()`.
- Naming a scene that is not in the plan: removed the unknown-id guard.
- Editing a length while the timeline is narration-locked: forced the guard
  false.
- Acting on a job that is not paused: removed the status check in the shared
  loader — the test still passed, because each route's own status-guarded UPDATE
  catches it too, so I removed both and confirmed it then failed. Defence in
  depth is why the single mutation survived, not a hole in the test.
- Reading another tenant's job: dropped `tenantId` from the loader's WHERE.
- Redrawing a still: persisted the old plan instead of the updated one.
- The redraw cap: changed `>=` to `>`.
- A failing image provider: changed 502 to 500.
- Approving: removed the status condition from the claim (the concurrent test
  fails on its own; the sequential one needed both guards removed); removed the
  expiry clear.
- Discarding: flipped the refund from credit-funded to quota-funded, which
  needed the two stale rows in the sweep test to differ in size before it was
  visible; removed the status condition from the flip.
- The storyboard expiry sweep: made it ignore the deadline; flipped which
  funding it refunds; stopped it clearing the expiry.
- The stuck-job sweep: made it ignore the age cutoff; made it eat
  `awaiting_review` rows too.
- The review toggle: defaulted it off; forced it on.

Two of the new tests fire a pair of requests at the same job with
`Promise.all` — one approving, one discarding. Those are the cases the atomic
claim exists for, and they were the mutations that bit hardest: with the status
condition removed, two concurrent discards refund twice.

Removing `?? true` from the review flag is worth naming, because a mutation
found it: the request schema already defaults the field, so the fallback in the
route could never fire. It now reads `body.reviewStoryboard` with a comment
saying where the default lives.

## Where I departed from what we agreed

Five places, all deliberate.

**Stock footage has no storyboard yet.** You asked for all four engines for
uniformity, and the next patch delivers three of them. But topic mode's stock
branch is the one place a storyboard does not fit the shape of the feature: its
visuals are searched, not prompted, so there is no prompt to edit — and a stock
plan would have to park remote clip URLs in a JSON blob the user can PATCH,
which would make approving a server-side fetch of a user-influenced host. That
is the SSRF surface we ruled out for reference videos. Doing it properly means
downloading the candidate clips into your own storage at plan time, which is a
real change to that branch rather than a storyboard change.

**Scene lengths are read-only in this patch.** You suggested enforcing a length
per model, an image every three to five seconds. I agree, and it is the next
patch, because in this patch's only engine it would be dead code: the timeline
comes from narration that has already been recorded, so a length edit would
either desync every later scene from the audio or silently change the total
length. The plan carries a `timelineLocked` flag for exactly this, the PATCH
route rejects length edits outright rather than accepting and ignoring them,
and the studio hides the control. Text, image and slideshow are the engines
whose timelines are actually free, so the clamp lands with them.

**Billing is reserve-then-refund, not literally two-stage.** Two-stage assumes
the animation costs something the storyboard did not, and here it does not — the
stills are reused, so there is no second charge to make. Worse, a second funding
check would let someone spend ten minutes editing a plan and then be told they
cannot afford to render it. So the reservation still happens when the job is
created, and discarding or expiring gives it back. You pay once, at the same
moment as before, and you can always get out.

**A missing preview fails the render instead of quietly regenerating.** If a
scene's still is absent at approve time, the job fails and refunds rather than
generating a replacement frame. Silently substituting a frame you never saw
would make "what you approved is what you get" untrue, which is the one promise
this feature rests on.

**The sweep does more than storyboards.** It also settles video jobs orphaned in
`queued` or `processing`. That is a pre-existing bug I found while writing the
expiry sweep: background jobs run in-process, so a restart loses the runner and
leaves the row `processing` forever with the reservation already spent. The image
pipeline already had this sweep; video did not.

## Left alone

`characterClip.ts` — text-to-video's single-clip path — still has no storyboard
and no uniformity pass. Both arrive together in the next patch, when that engine
becomes multi-scene; splitting them would mean touching the file twice.

The job polling interval is unchanged. `awaiting_review` deliberately does not
poll: nothing is happening until you act, and approving writes the new row
straight into the query cache, which restarts polling by itself.

## Still not pushed

Three commits now sit on `fix/render-and-routing` with no way out of this
sandbox: `d325832`, `655a499` and `9a161a9`. Apply the patches in Replit and
push from there, or paste a fine-grained token scoped to KOKAO
Contents:Read/write and I will push all three — revoke it afterwards.
