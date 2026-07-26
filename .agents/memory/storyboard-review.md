---
name: Storyboard review pause
description: Design invariants for the video storyboard review flow (awaiting_review pause, approve/discard claims, redraw caps, funding refunds).
---

# Storyboard review pause

- All four engines now plan: text_to_video (1–5 shots, priced 1 unit/shot, shotCount pinned at enqueue — review-off still renders every paid shot), image_to_video/slideshow (plan shows the user's own uploads; redraw is refused BEFORE the atomic cap claim via `storyboardPreviewsAreGenerated` so a refusal can't burn a re-roll), topic video with generated visuals. Refund paths compute units from persisted engine/options so multi-shot reservations refund fully.
- Topic videos with generated visuals (character / AI b-roll) pause in `awaiting_review` after the cheap half (script, narration, one still per scene); the stills are the exact frames the render animates, so approval regenerates nothing and edits/redraws are unbilled. Stock-footage mode deliberately has no storyboard (searched clips = SSRF surface if user-PATCHable URLs are fetched server-side).
- Billing is reserve-then-refund: one reservation at creation; discard or day-long expiry (sweep) refunds it. There is no second funding check at approve — never add one (a user must always be able to render a plan they've been editing).
- **Persist `funding` on the job row at creation, not at the runner's claim.** A restart before the claim leaves a queued orphan; the sweep can only refund a credit reservation recorded on the row. (Was a real bug caught in review.)
- **Caps stored inside a jsonb blob must be spent with an atomic conditional UPDATE** (jsonb_set increment + `< cap` predicate in the WHERE), never read-then-write in app code — concurrent requests race past the pre-check. Release the claim (best-effort decrement) on provider failure, and persist post-generation results with jsonb_set on the sub-key only so a slow request can't overwrite the counter.
- Approve/discard both use status-guarded atomic claims (`awaiting_review` → next status in one conditional UPDATE); concurrent approve+discard tested with Promise.all.
- Missing preview at approve time fails + refunds rather than silently regenerating ("what you approved is what you get").
- Scene lengths are read-only while `timelineLocked` (narration-driven timeline); the PATCH route rejects, not ignores, length edits.
- The video job sweep also settles jobs orphaned in queued/processing after a restart (in-process background jobs lose their runner).

**Why:** review flow rests on "you see and approve exactly what you pay for"; the two bolded rules were review-caught defects (lost refunds, cap bypass by race).
**How to apply:** any new pausable/reviewable pipeline, any jsonb-stored counter, and any reserve-then-refund funding path.
