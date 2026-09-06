---
name: Guided intrinsic lip sync
description: Rules for automatic locale-aware lip sync of eligible Guided Story dialogue shots.
---

New Guided Story jobs automatically apply intrinsic dialogue finishing only to unambiguous shots with exactly one visible role and dialogue owned by that role. Build-up, group, narration, reaction, ambiguous, and historical jobs keep their normal rendering. Manual Replay Native Dialogue remains a separate unchanged workflow.

Models explicitly allowlisted as providing synchronized native dialogue audio (currently OpenRouter Seedance 2.5) bypass the Replicate intrinsic-finishing snapshot. Their frozen Guided Story model enables native audio, and the runner defensively preserves the base result rather than replacing its soundtrack with Replicate output.

**Why:** The Character Dialogue sequence is more reliable when the provider receives one approved face, exact role-owned audio, and a controlled silent plate. Applying it to multi-face or ownerless scenes recreates active-speaker ambiguity.

**Why:** Re-running a native synchronized-audio model through Replicate adds an unnecessary credential, cost, and second transformation that can replace the model's intended lip-sync/audio result.

**How to apply:** Check the frozen provider/model native-audio capability before planning, pricing, funding, preflighting, or dispatching intrinsic Replicate work. For all other eligible models, freeze scenes, locale, role voice, model, prices, and checkpoints; generate exact locale-aware audio, animate a silent approved-still plate, and deliver the exact synced audio.

Receipt-free failures are fail-soft and retain the corresponding completed base segment. A provider receipt without durable output is outcome-unknown and must fail closed; record and mark partial receipts accounted before recovery so completed work is never charged twice.

**Why:** The base video protects delivery, while receipt-aware checkpoints protect users from losing paid work or duplicating provider charges after crashes.

**How to apply:** Never infer intrinsic finishing for old rows. Preserve the completed base before dispatch, update checkpoints around every paid boundary, concatenate successful intrinsic scenes with untouched base intervals, and settle only durable unaccounted provider events.

When model resolution forces synchronized native audio, persist that decision in both the immutable resolved-model contract and the job-level audio option consumed by workers. Clear every external lip-sync snapshot at the same boundary.

**Why:** The enqueue route may resolve a native-audio model after request options are built, while normal and repair workers reconstruct render options from the job-level field. Updating only the nested model snapshot makes the saved job look correct but silently sends the worker down the external-narration path.

**How to apply:** Treat native-audio activation as one atomic persisted contract: prompt format, provider/model identity, resolved audio capability, worker-visible audio flag, and external-finishing disablement must change together. Regression tests must cover enqueue through worker reconstruction, not only renderer calls with hand-built options.