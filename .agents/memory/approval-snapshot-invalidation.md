---
name: Approval snapshot invalidation
description: Durable concurrency rule for approval checkpoints mirrored across editable drafts and immutable execution snapshots.
---

When an approved reference is replaced, atomically revoke approval in every executable snapshot—not only in the editable draft—and serialize the replacement against active workers.

**Why:** UI and draft-level gates are insufficient when direct endpoints or already-running workers still hold an older approved snapshot. They can regenerate or persist stale output after selective invalidation.

**How to apply:** For any draft-to-job approval checkpoint, update the job snapshot to a non-executable pending reference in the same transaction that invalidates outputs. Reject replacement while relevant workers are nonterminal, or fence every worker persistence write with a generation token.