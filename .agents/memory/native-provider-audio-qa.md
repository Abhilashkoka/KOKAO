---
name: Native provider audio quality
description: Delivery, settlement, and retry rules for provider-generated speech quality failures.
---

Validate provider-native speech only after its output and billable receipt are durable, but before final delivery. Compare both the provider's language detection and sequence-aware dialogue fidelity against the immutable Guided snapshot. Treat short conflicting language labels as uncertain rather than conclusive.

**Why:** Native video models can return usable, billable footage with missing, wrong-language, or rewritten speech. Reusing that checkpoint in an ordinary retry repeats the same terminal failure, while discarding its receipt would incorrectly refund completed provider work.

**How to apply:** Missing speech, wrong language, and dialogue drift settle proven receipts and require a fresh restart. Local extraction or ASR outages are verification failures: retain the checkpoint and allow ordinary retry without redispatching the video provider.