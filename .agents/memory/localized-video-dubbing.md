---
name: Localized video dubbing
description: Non-obvious guarantees for turning approved Indic subtitle tracks into finished dubbed videos.
---

Create one durable video job per target locale so successful outputs survive a sibling-language failure and each language can be retried independently. Probe the uploaded source cut before voice work, reject cues outside that cut, and synthesize cues independently. Apply the existing 8% tempo tolerance first; if a cue still overflows, shorten and re-synthesize only that cue, with at most two meaning-preserving repair attempts. Persist the exact final cue text alongside the completed output.

Source-speaker preservation must not use a dubbing provider's translated narration as the final audio. Use the provider dub only as a clean reference sample, create a temporary voice from it, synthesize the exact KOKAO-approved/repaired cues through the shared fitting pipeline, and always remove the temporary voice. The voice-cloning kill switch gates this route and runner branch.

**Why:** Provider-owned translation can disagree with reviewed subtitles, while changing whole tracks to repair one overflow invalidates otherwise approved work. Separate jobs and exact final-cue snapshots keep subtitles, spoken audio, retries, downloads, and billing truthful.

**How to apply:** Any localized-dub provider or renderer must stay on the durable video-job funding/refund rail, validate positive audio duration, run source-duration validation before provider work, keep provider-specific voice data inside the immutable job snapshot, and gate every voice-cloning execution path.