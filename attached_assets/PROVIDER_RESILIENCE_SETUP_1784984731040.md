# Patch 7 — Provider resilience

`provider-resilience.patch` · apply after `pre-render-gates.patch`

## Apply

```bash
git apply provider-resilience.patch
```

No schema change, no OpenAPI change, no codegen, no new dependency, no UI change. Nothing to run after applying.

## What it does

Four places in the pipeline had exactly one way to succeed. If that one vendor was having a bad ten minutes, the tenant's job died — usually minutes in, after the script had already been written and the units already spent. The image pipeline learned to fall back a while ago. This patch teaches the other four the same trick, and adds a check that refuses doomed jobs before they cost anything.

**Preflight, before funding.** `POST /ai/generate-video` now works out which providers the job will actually reach and checks them while refusing is still free. A capability with nothing configured returns **400** with a plain sentence about which key is missing. A capability that is configured but whose every candidate has an open circuit breaker returns **503** — *"Nothing was charged — please try again in a few minutes."* Neither touches quota or credits. Refunds return units; they never return the four minutes.

It makes no network calls. It reads the same in-process breaker state the failover paths already maintain, so it only knows what real jobs have already learned, and a capability passes as soon as **one** of its interchangeable candidates is healthy — the same bar the runtime uses. Preflight never refuses a job that would actually have succeeded.

**Narration can change voice.** Text-to-speech is a registry now, same shape as the image and stock registries: the built-in OpenAI proxy stays primary (no key, and it's the voice tenants have already heard), with Deepgram Aura behind it. Failover is at **track** level, not per sentence — cue timings come from each sentence's WAV header and the composer needs one consistent format across the take, so half a track from each vendor would be rejected as inconsistent. Re-speaking the track costs a few seconds; failing costs a video unit.

**Voice notes stop getting lost.** A transient speech-to-text failure now tries up to two other configured providers, healthiest first. A recording the tenant just made cannot be made again on demand.

**Video generation walks the model chain.** There is one AI video provider today, so failover happens at model level: the configured model first, then up to two of that provider's other catalog models for the same engine mode. That isn't a lesser fallback here — a queue backed up behind one hosted model is the common failure, and the same account's other models are usually fine.

Across all four: a **permanent** failure (a prompt the safety filter rejected, a bad key, unusable audio) fails immediately without trying anything else, because the next candidate would reject it identically. Only 429/5xx/network/timeout triggers failover.

## Three decisions worth knowing about

**Deepgram narration reuses the speech-to-text key.** If you've already saved a Deepgram key in the admin dashboard for transcription, narration failover is on — same account, same key. Asking for it twice would be a worse admin screen, not a safer one. `DEEPGRAM_API_KEY` as a secret works too. With no Deepgram key at all, narration behaves exactly as it did before this patch.

**A fallback model's error never masks the configured model's error.** Some Replicate models need per-account access; a 404 or 402 from one of those is that model's problem, not the tenant's. The chain keeps walking, and if nothing works the tenant hears about the model you actually configured.

**Preflighting can't deadlock a recovering provider.** Nothing is charged, so the half-open probe isn't lost: `isProviderHealthy` starts returning true again purely on the breaker's timer expiring, and the next real job probes the provider for real.

## Files

| | |
|---|---|
| `artifacts/api-server/src/lib/videoGen/preflight.ts` | new — the pre-funding dependency check |
| `artifacts/api-server/src/lib/videoGen/preflight.test.ts` | new — 20 tests |
| `artifacts/api-server/src/lib/videoGen/topicVideo/tts.ts` | new — the narration provider registry |
| `artifacts/api-server/src/lib/videoGen/topicVideo/tts.test.ts` | new — 13 tests |
| `artifacts/api-server/src/lib/videoGen/videoFallback.test.ts` | new — 10 tests |
| `artifacts/api-server/src/lib/asr/fallback.test.ts` | new — 7 tests |
| `artifacts/api-server/src/lib/videoGen/topicVideo/narration.ts` | modified — speaks through the registry, re-speaks on failover |
| `artifacts/api-server/src/lib/videoGen/index.ts` | modified — model chain failover |
| `artifacts/api-server/src/lib/asr/index.ts` | modified — provider failover |
| `artifacts/api-server/src/routes/videos.ts` | modified — preflight before funding, five lines |
| `artifacts/api-server/src/lib/imageGen/index.ts` | modified — one word: `export function imageGenHealthKey` |
| `artifacts/api-server/src/lib/videoGen/topicVideo/stockSources.ts` | modified — one word: `export function stockHealthKey` |
| `artifacts/api-server/src/routes/videos.test.ts` | modified — the route tests now configure provider keys, since the route preflights |

## Verified

Full api-server suite: **1337 tests passing** across 110 files. Typecheck clean across all 14 workspace projects. OpenAPI spec lint clean.

The circuit breaker knobs are unchanged and still live in `lib/providerHealth.ts`: three consecutive failures opens a breaker, reopening backs off from 60s to a 10-minute ceiling. Fallback breadth is `ASR_FALLBACK_LIMIT` and `VIDEO_GEN_FALLBACK_LIMIT`, both 2, matching `IMAGE_GEN_FALLBACK_LIMIT`.
