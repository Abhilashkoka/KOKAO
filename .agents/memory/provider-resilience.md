---
name: Provider resilience & preflight
description: Video-pipeline provider failover model and the pre-funding preflight check
---

- Preflight (`videoGen/preflight.ts`) runs in the generate-video route BEFORE funding: 400 when a capability has nothing configured, 503 when every candidate's breaker is open. It makes no network calls — it only reads in-process breaker state from `providerHealth.ts` — so it never refuses a job that would have succeeded, and it can't consume the half-open probe (health returns true again purely on the breaker timer).
- Failover exists in four places with one shared rule: only transient errors (429/5xx/network/timeout) trigger failover; permanent errors (rejected prompt, bad key, unusable audio) fail immediately because the next candidate would reject identically.
- TTS is a registry (builtin OpenAI primary, Deepgram Aura fallback reusing the ASR Deepgram key). Failover is whole-track, never per-sentence — cue timings need one consistent WAV format across the take.
- Video-gen failover is two-tier: first the model chain WITHIN the selected provider (queue behind one hosted model is the common failure), then a provider-level failover to the other configured static provider (replicate↔openrouter) when the whole chain exhausts on transient errors or the breaker is already open. The substitute must be configured + healthy + have a priced default model (`ai_model_prices` gate, same as textgen failover); custom providers never serve failovers. Cost attributes to the serving provider automatically because jobRunner reads `result.provider`. Deduped `videogen_failover` superadmin alert (10-min throttle + unread-row refresh in `notifications.ts`), auto-resolved on primary recovery. A fallback model's/provider's error never masks the configured provider's error.
- Kill switch `providerResilience` gates ONLY the tenant-facing preflight refusal (fail-open); internal failovers stay ungated, matching the image pipeline's ungated fallback precedent.
- Fallback breadth knobs: `ASR_FALLBACK_LIMIT` / `VIDEO_GEN_FALLBACK_LIMIT` = 2; breaker knobs live in `lib/providerHealth.ts`.
- Admin fallback orders are exact persisted chains: an absent family keeps historical automatic routing, while a saved empty list disables fallback. Manual priority never bypasses configuration, health, capability, pricing, or transient-error gates; selected primaries stay pinned where the family has one.

**Why:** jobs died minutes in on one vendor's bad ten minutes, after quota was already spent; refunds return credits, not time.
