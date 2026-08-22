---
name: Localized video dubbing
description: Non-obvious guarantees for turning approved Indic subtitle tracks into finished dubbed videos.
---

Approved Telugu, Tamil, and Hindi cue wording and timing are immutable production inputs. Probe the uploaded source cut before TTS, reject cues outside that cut, synthesize each cue independently, and fail rather than rewriting text or exceeding the 8% speed-up cap. Indic dubbing uses the OpenAI stock-voice path only; never fail over to an English-only voice catalog.

**Why:** A source-cut mismatch can otherwise spend provider/encode compute and then refund, while silent rewriting or English-only failover invalidates the user's reviewed script.

**How to apply:** Any new localized-dub provider or renderer must preserve exact cue text/timing, validate positive audio duration, remain on the durable video-job funding/refund rail, and run source-duration validation before provider work.