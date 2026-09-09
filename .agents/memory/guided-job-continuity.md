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

When recovery resets attempt-scoped likeness/voice consent, the ready-to-build screen must show a dedicated confirmation and disable enqueue until it is checked. The enqueue API must require that confirmation and return a consent-specific error.

**Why:** Hiding renewed consent behind already-approved cast cards allowed submission but produced a misleading combined “approve cast/script/backdrop” rejection.

**How to apply:** Keep immutable cast approvals separate from per-attempt consent. Never require reapproval just to renew consent, and never report a consent failure as a cast-reference failure.

A failed recovery child may still be backed by a draft linked to the root attempt. Treat the recovery chain's durable root/source linkage as valid when reopening the draft, and clear stale unavailable/dismissed markers after the detach succeeds.

**Why:** Requiring the draft to point directly at the latest recovery child falsely marked an intact editable story as deleted after a child attempt failed.

**How to apply:** Validate the draft link against the current job plus its immutable recovery root/source IDs. Keep the failed rows as audit history, but release the preserved draft for a new provider attempt.

Re-approving an unchanged script after recovery must be a no-op when every script role still has a locked cast member. Only an actual script edit may invalidate cast assets and start paid replacement work.

**Why:** The recovery editor exposed an already-approved script, and its ordinary approval action discarded exact approved portraits/sheets and bought replacements.

**How to apply:** Preserve cast IDs, byte-bound approvals, and generated assets when `scriptApprovedAt` and complete role coverage still exist. Script-save invalidation remains the boundary for regeneration.

Long-lived Guided creation leases must carry an API-process identity. A restart immediately terminalizes leases owned by the prior process; expiry remains the fallback for abandoned work within one live process.

**Why:** A two-hour Atlas registration lease protected slow active calls but also trapped jobs whose route worker disappeared during a deployment restart, blocking retry despite no funding or accepted video task.

**How to apply:** Stamp creation leases with one process-lifetime ID, compare it in the startup sweep, and condition the terminal write on the exact owner and expiry. Missing process IDs are legacy/dead after the new process boots.