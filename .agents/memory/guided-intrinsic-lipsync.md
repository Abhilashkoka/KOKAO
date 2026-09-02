---
name: Guided intrinsic lip sync
description: Rules for automatic locale-aware lip sync of eligible Guided Story dialogue shots.
---

New Guided Story jobs automatically apply intrinsic dialogue finishing only to unambiguous shots with exactly one visible role and dialogue owned by that role. Build-up, group, narration, reaction, ambiguous, and historical jobs keep their normal rendering. Manual Replay Native Dialogue remains a separate unchanged workflow.

**Why:** The Character Dialogue sequence is more reliable when the provider receives one approved face, exact role-owned audio, and a controlled silent plate. Applying it to multi-face or ownerless scenes recreates active-speaker ambiguity.

**How to apply:** Freeze eligible scenes, locale, role voice, model, authoritative prices, and checkpoints before funding. Preflight the exact animation, advanced lip-sync, and non-stock voice providers before reservation. Generate exact locale-aware audio, fit it to the immutable slot, animate the approved still with provider audio disabled, lip-sync per scene, and deliver that exact synced audio rather than remuxing an independently synthesized base track.

Receipt-free failures are fail-soft and retain the corresponding completed base segment. A provider receipt without durable output is outcome-unknown and must fail closed; record and mark partial receipts accounted before recovery so completed work is never charged twice.

**Why:** The base video protects delivery, while receipt-aware checkpoints protect users from losing paid work or duplicating provider charges after crashes.

**How to apply:** Never infer intrinsic finishing for old rows. Preserve the completed base before dispatch, update checkpoints around every paid boundary, concatenate successful intrinsic scenes with untouched base intervals, and settle only durable unaccounted provider events.