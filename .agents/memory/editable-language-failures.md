---
name: Editable language failures
description: Why Guided script language failures must remain reviewable instead of being discarded.
---

Keep a structurally valid generated Guided script available for manual editing when spoken text is Romanized rather than in the selected native writing system. Permit intermediate draft saves while the user corrects individual lines; keep the warning current.

**Why:** The user reported a language error instructing them to edit the script, but no script was available to view or customize because generation rejected it before saving.

**How to apply:** Separate recoverable draft language warnings from approval and execution validation. Do not relax structural/timing checks or the existing approval acknowledgements. Incomplete display-only pronunciation or meaning must not prevent viewing a language-invalid draft.
