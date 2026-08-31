---
name: Guided job continuity
description: Product behavior for Guided Story submission, progress visibility, and actionable failure recovery.
---

A Guided Story draft must remain visible after its storyboard or video job is created. Submission should focus the active job's progress/review card rather than clearing the draft or presenting a fresh-start state.

**Why:** Clearing the active draft after linking a job made a successful submission look like a redirect to the main dashboard and hid the job's progress from the user.

**How to apply:** Keep linked drafts resumable, visibly identify the active job, and show queued/processing/review status in place. For failures, include the job number, a concrete required action, and a route back to the retained draft with the correction guidance highlighted.

When reopening a failed storyboard, preserve or restore cast members and exact approval receipts from the immutable job snapshot when the draft copy is missing them. Carry unchanged approvals to the reopened draft revision; reset only attempt-scoped consent.

**Why:** A failed-story detach retained zero-cost cast assets for billing but could drop or revision-invalidate the selections needed to reuse them, making completed work appear required again.

**How to apply:** Recovery must not ask users to regenerate or reapprove unchanged references. If the prior job snapshot proves the exact cast bytes, reuse those receipts and require fresh consent only where the next provider attempt actually needs it.