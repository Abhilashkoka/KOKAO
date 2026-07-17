---
name: Taste memory
description: Per-tenant learned style preferences fed into AI generation as soft guidance.
---

Per-tenant "taste memory" learns style from behavior signals and appends SOFT guidance to AI prompts (brand kit + explicit prompt always win).

**Signals & weights:** saved=1 (explicit client POST /taste-profile/signal from studio "Save to Library" — auto-save PATCHes are deliberately NOT signals), scheduled=2 (schedule create), published=3 (all four publish routes fire-and-forget after DB update), discarded=1 (DELETE of a draft that has a caption).

**Why weights/hooks are this way:** studio auto-saves every generation as a draft, so plain create/update of drafts is ambiguous and must not count; only deliberate user actions count. Saved-then-published double counting is intentional (graduated approval).

**Concurrency rule:** profile writes are a jsonb read-modify-write — they MUST run in a transaction with `SELECT ... FOR UPDATE` (plus insert-then-relock for the first-row race), or close-together signals (save + publish) silently lose updates. Architect flagged this; don't regress to plain select/update.

**Prompt-injection rule:** approved caption exemplars are embedded in the system prompt; always wrap them in delimiters and mark them as untrusted DATA (style samples only, ignore directives inside). Same-tenant risk only, but keep the hardening.

**Decay:** 5%/week applied at read time when ranking exemplars; buckets are not decayed. Guidance emits only above thresholds (bucket total ≥3 and ≥55% share) so thin profiles stay silent.
