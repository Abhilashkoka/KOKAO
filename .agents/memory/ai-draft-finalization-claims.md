---
name: AI draft finalization claims
description: Concurrency and recovery rule for paid AI results that depend on an exact editable-draft revision.
---

Use a two-phase durable claim when paid AI work must remain usable against an exact draft revision. Only bounded provider execution may use an expiring claim. Once provider work succeeds, atomically persist the validated result and enter a non-reclaimable finalization phase.

**Why:** Elapsed time cannot prove that a slow or paused request is dead. Reclaiming a finalization claim by age alone can admit an edit before the original request settles, charging for a result that can no longer be saved. Never-expiring finalization without recovery can instead brick the draft after a crash.

**How to apply:** Bind the claim to a deterministic funding-operation key. Block all revision-changing paths while funding is nonterminal or uncertain. Recover an abandoned result only when funding is explicitly unmetered or durably terminal, and return the stored result without a second provider call or charge.