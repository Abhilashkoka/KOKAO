---
name: Native provider audio quality
description: Delivery, settlement, and retry rules for provider-generated speech quality failures.
---

Use provider-native speech for every Guided locale when the frozen model explicitly supports synchronized audio; locale alone must never force a separate narration path. Validate native speech only after its output and billable receipt are durable, but before final delivery. Compare both the provider's language detection and sequence-aware dialogue fidelity against the immutable Guided snapshot. Treat short conflicting language labels as uncertain rather than conclusive. Strong matching Telugu, Tamil, or Devanagari transcript script outranks a conflicting provider label, but exact dialogue similarity must still pass.

**Why:** Atlas/Seedance and other capable models can produce localized synchronized speech; an English-only gate needlessly changed Telugu jobs to separate narration and hid the provider behavior the QA layer was designed to measure. Native video models can still return usable, billable footage with missing, wrong-language, or rewritten speech, so QA remains mandatory.

**How to apply:** At enqueue, retry, and fresh restart, choose native audio from the frozen model capability regardless of Guided locale and disable secondary lip-sync/narration when selected. Missing speech, wrong language, and dialogue drift settle proven receipts and require a fresh restart. Local extraction or ASR outages are verification failures: retain the checkpoint and allow ordinary retry without redispatching the video provider. Persist only bounded QA evidence (normalized language codes, word count, similarity, outcome, and ASR identity), never transcript text or arbitrary provider payloads.