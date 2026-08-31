---
name: Guided meaning metadata
description: Concurrency and billing rules for display-only English meanings on non-English Guided Story lines.
---

Treat a line's English meaning as display-only metadata: refreshing it must not advance the source-script revision or alter approvals, timing, ownership, cast, speech, or storyboard inputs.

**Why:** Advancing the source revision makes unchanged approvals stale, while leaving the revision stable lets an already-started full-state save overwrite a paid translation unless that save merges current metadata.

**How to apply:** Translation writes must compare the exact revision, line identity, source text, and missing meaning atomically. Full-state saves must preserve a concurrently committed meaning only when scene ID, line ID, and source text are unchanged. Once provider success is confirmed, settle its cost even if the persistence compare-and-set loses a race.