---
name: Sarvam localization narration
description: Sarvam bulbul:v3 contract and safe provider-key health status behavior for localized narration.
---

Sarvam bulbul:v3's current REST contract accepts a singular `text` field, a lowercase model-compatible speaker, a required BCP-47 target locale, and returns base64-encoded WAV audio in `audios`. Do not carry over older array-input or unsupported-model fields from other Sarvam examples.

**Why:** A plausible-looking but stale request shape can pass mocked tests and fail only after a creator has approved a localized render.

**How to apply:** Keep a documented request-shape test. Bind provider/model/speaker and resolved credential once before speaking a localized track; do not fall back midway through cue synthesis. Persist a credential health result only when the credential version/fingerprint still matches what was actually tested, including env-backed keys.