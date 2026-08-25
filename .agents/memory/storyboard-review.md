---
name: Storyboard review pause
description: Design invariants for the video storyboard review flow (awaiting_review pause, approve/discard claims, redraw caps, funding refunds).
---

# Storyboard review pause

- All four engines now plan: text_to_video (1–5 shots, priced 1 unit/shot, shotCount pinned at enqueue — review-off still renders every paid shot), image_to_video/slideshow (plan shows the user's own uploads; redraw is refused BEFORE the atomic cap claim via `storyboardPreviewsAreGenerated` so a refusal can't burn a re-roll), topic video with generated visuals. Refund paths compute units from persisted engine/options so multi-shot reservations refund fully.
- AI-b-roll topic videos pause after narration + exact preview stills. Character Story is different: it pauses on script and scene directions only; narration, keyframes, music, and video generation wait for approval. Narration is checkpointed before keyframes so a later frame failure never re-voices the script. Stock-footage mode deliberately has no generic storyboard (searched clips = SSRF surface if user-PATCHable URLs are fetched server-side).
- Character Dialogue pauses before source plates, speech, lip-sync, music, or B-roll. Approved dialogue text is immutable; character visual direction and supporting B-roll direction remain editable. Approval must resume the specialized dialogue renderer, and presenter-template B-roll is composited only after dialogue composition.
- Paid presenter B-roll and MusicGen work must checkpoint both the provider event and stored asset path. Partial failures settle unaccounted events and mark them accounted; retries reuse the saved assets rather than generating again.
- Billing is reserve-then-refund: one reservation at creation; discard or day-long expiry (sweep) refunds it. There is no second funding check at approve — never add one (a user must always be able to render a plan they've been editing).
- **Persist `funding` on the job row at creation, not at the runner's claim.** A restart before the claim leaves a queued orphan; the sweep can only refund a credit reservation recorded on the row. (Was a real bug caught in review.)
- **Caps stored inside a jsonb blob must be spent with an atomic conditional UPDATE** (jsonb_set increment + `< cap` predicate in the WHERE), never read-then-write in app code — concurrent requests race past the pre-check. Release the claim (best-effort decrement) on provider failure, and persist post-generation results with jsonb_set on the sub-key only so a slow request can't overwrite the counter.
- Approve/discard both use status-guarded atomic claims (`awaiting_review` → next status in one conditional UPDATE); concurrent approve+discard tested with Promise.all.
- Missing preview at approve time fails + refunds rather than silently regenerating ("what you approved is what you get").
- Scene lengths are read-only while `timelineLocked` (narration-driven timeline); the PATCH route rejects, not ignores, length edits.
- The video job sweep also settles jobs orphaned in queued/processing after a restart (in-process background jobs lose their runner).

**Why:** review flow rests on "you see and approve exactly what you pay for"; the two bolded rules were review-caught defects (lost refunds, cap bypass by race).
**How to apply:** any new pausable/reviewable pipeline, any jsonb-stored counter, and any reserve-then-refund funding path.

## Raw AI plan on the storyboard (aiPlan)
`storyboard.aiPlan` stores the planner's untouched JSON reply ({flow, raw, capturedAt}) for audit/later customization; null when planning fell back. Any code that rewrites the storyboard jsonb must spread the existing board (or jsonb_set only `scenes`) so aiPlan survives PATCH, insert-scene, preview re-roll, and narration refresh.

## Saved-plan reuse (suppliedPlan)
- A prior job's `storyboard.aiPlan` (optionally hand-edited) can seed a new topic generation via `planSource` on generate-video; persisted as `options.suppliedPlan = {flow, raw}`.
- Pattern: validate strictly at the route BEFORE funding (reject, never silently fix); planners then run the supplied raw through the SAME clamps as a live AI reply (costume lock, style clamp, per-scene fallback), so an edited plan can never break consistency rules.
- Reuse path in planners fails hard (throw) on missing prompts/scenes — never the silent narration fallback, since the user chose that exact plan.
- Flow guard: broll↔"ai" visuals, character↔"character"; a mismatched or missing plan is a 400 with a pointed message.
- Gotcha fixed: `await logCompiledPrompt` inside a planner's try block can downgrade a successful plan to fallback (and drop rawPlan) — prompt logging must be locally try/caught, best-effort.

## Clip storyboards & the Prompt Kit (text_to_video)
- Both governed flows now run for clip plans: video_script governs the shot-split at planning; video_scene_image runs a post-approval "polish" pass on prompt-source shots only.
- The polish result is persisted once as scene.renderVisual before the first render — retries of an approved plan must render from identical prompts, never re-polish.
- Character shots are exempt from post-approval rewriting: the approved keyframe is the contract.
- jobRunner tests that deep-compare rendered storyboards must stub polishStoryboardPrompts, or the polish mutates the plan (and can hit a live model).
