---
name: Character dialogue recovery
description: Durable retry and multilingual segmentation rules for saved-character dialogue videos.
---

Failed Character Dialogue jobs remain immutable accounting records. A retry creates one tenant-scoped child job under a source-row lock, copies the frozen scene/music checkpoints, and funds only provider operations whose reusable artifacts are still missing. A fully checkpointed failure may create a zero-unit child that only reruns local composition.

**Why:** Reopening the original reservation can mix settled and unsettled funding, and rerunning completed scenes can double-charge paid provider work. An immutable child gives each attempt one funding record while preserving lineage.

**How to apply:** Persist provider events before later storage/composition work, mark checkpoint events accounted when a failed attempt is settled, omit accounted events from retry usage, and prevent parallel children from the same failed source.

Character Dialogue segmentation is locale-aware and must preserve the approved script exactly. Use conservative word budgets for whitespace-delimited scripts and grapheme budgets for CJK/Thai or oversized tokens; final lip-sync clips are strictly trimmed to measured narration duration before subtitle offsets are composed.

**Why:** Word counts collapse whitespace-free scripts into one falsely short scene, and provider padding accumulates subtitle drift across concatenated scenes.

**How to apply:** Treat planner estimates only as pre-funding bounds; use measured narration and raw provider durations for execution, billing, checkpointing, and final QA.