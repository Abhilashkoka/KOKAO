---
name: Storyboard narration editing & add-scene
description: Invariants for editing narrated topic storyboards — re-voice on approve, addedScenes billing, insert funding/refund rules.
---

## Re-voice on approve, not on edit
Narrated (topic) storyboard text edits do NOT touch audio at edit time. On approve/resume, the runner compares the normalized joined scene texts against the joined narration cue texts; equal (true by construction on untouched boards, since the planner built scene text from cues) → skip TTS entirely, so unedited boards approve free. Different → re-synthesize the whole track, recompute per-scene durations from the new cues, persist the refreshed board BEFORE rendering so a retry resumes from the actual recording.
**Why:** charging/re-recording per keystroke would be wasteful and racy; comparing texts-vs-cues is the only drift signal that needs no extra flag.

## Save and render must be snapshot-aware
When a review editor saves asynchronously, completion may clear only the exact draft snapshot submitted. If newer typing exists, keep it visibly unsaved; a combined save-and-render action must stop before approval rather than render the older snapshot.
**Why:** network completion can otherwise erase text typed after the click and falsely claim the latest visible script was saved or rendered.
**How to apply:** compare current drafts with the submitted snapshot in both save-only and save-then-approve flows, and cover both with deferred-request tests.

## addedScenes billing pattern
Scenes inserted during review are billed by bumping `options.addedScenes`; `videoJobUnits(engine, options)` includes it, so every price path (usage metering on success, refunds on cancel/discard/failure/sweep) reprices automatically — no path-by-path bookkeeping.
**How to apply:** any future review-time paid extra should follow the same shape: a counter in options that units.ts reads, never a separate charge record.

## Insert funding & refund rules
- Insert funds the SAME way as the job: credit → spendCredit 1 unit up front; quota → headroom check only (metered on success). Mixed funding would break refund paths.
- Preview still is generated BEFORE persisting; provider failure refunds and leaves the board untouched.
- Persist runs in a FOR UPDATE tx that re-reads the CURRENT board (concurrent edits kept), re-checks status/cap/duplicate id; the tx is wrapped in try/catch that refunds on DB failure too. Refund failures are logged at error level (tenant may be owed a credit) — never swallowed silently.
- Blank narration text is never accepted (a narrated scene with no words has no length); text edits are rejected on boards with `narration == null`.
