---
name: Provider resilience & preflight
description: Video-pipeline provider failover model and the pre-funding preflight check
---

- Preflight (`videoGen/preflight.ts`) runs in the generate-video route BEFORE funding: 400 when a capability has nothing configured, 503 when every candidate's breaker is open. It makes no network calls — it only reads in-process breaker state from `providerHealth.ts` — so it never refuses a job that would have succeeded, and it can't consume the half-open probe (health returns true again purely on the breaker timer).
- Failover exists in four places with one shared rule: only transient errors (429/5xx/network/timeout) trigger failover; permanent errors (rejected prompt, bad key, unusable audio) fail immediately because the next candidate would reject identically.
- TTS is a registry (builtin OpenAI primary, Deepgram Aura fallback reusing the ASR Deepgram key). Failover is whole-track, never per-sentence — cue timings need one consistent WAV format across the take.
- Video-gen failover is model-level within the single provider (queue behind one hosted model is the common failure). A fallback model's error never masks the configured model's error.
- Kill switch `providerResilience` gates ONLY the tenant-facing preflight refusal (fail-open); internal failovers stay ungated, matching the image pipeline's ungated fallback precedent.
- Fallback breadth knobs: `ASR_FALLBACK_LIMIT` / `VIDEO_GEN_FALLBACK_LIMIT` = 2; breaker knobs live in `lib/providerHealth.ts`.

**Why:** jobs died minutes in on one vendor's bad ten minutes, after quota was already spent; refunds return credits, not time.
