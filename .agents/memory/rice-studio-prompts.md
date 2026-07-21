---
name: RICE studio prompts
description: Invariants for the AI studio caption/campaign prompt builder and the clarifying-questions flow.
---
- Prompt section order is Role → Instruction → Context → Constraints → Examples → Output Format. Taste-memory guidance goes in Examples, deliberately AFTER Constraints.
  **Why:** taste memory is soft guidance; brand hard rules must always win, and models weight later hard constraints correctly only if soft examples don't precede them labeled equally.
  **How to apply:** never move Examples ahead of Constraints in the builder; new soft-signal inputs join Examples, hard rules join Constraints.
- Clarify path (model asks questions instead of generating) must charge nothing: caption releases the reserved funding, campaign refunds only credit-funded units and records no usage. Frontend must clear stale clarify questions on ANY superseding success (caption, campaign, image) and on discard.
- Campaigns draft a master caption for the platform with the largest character capacity first, then condense per platform — keeps messaging consistent across sizes.
