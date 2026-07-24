# KOKAO Reliability Core — failover, quality gate, scene diversity, live stages

This is the "make it exceptional" patch: the Tier-1 reliability and quality items from the open-source study, built natively for KOKAO. Every idea is either reimplemented from scratch (OpenMontage is AGPL — no code copied) or adapted from MIT-licensed patterns (OmniRoute).

## Apply it (on top of smart-visuals.patch)

```bash
git am reliability-core.patch
pnpm --filter @workspace/db run push   # adds video_generations.stage (additive, no data loss)
```

Restart the app. No new dependencies, no new secrets.

## 1. Provider failover — generation stops dying on one provider's bad day

A new in-memory circuit breaker (`lib/providerHealth.ts`) watches every image provider and stock source. Three consecutive transient failures (429/5xx/network/timeout) open the breaker with an exponential cooldown (60s → capped at 10 min); one success closes it.

- **Image generation**: your selected provider is always tried first (that attempt doubles as the recovery probe). If it fails *transiently*, up to two other configured providers take over — healthiest first, each with its own default model, reference images only routed to providers that accept them. A bad prompt or invalid key never triggers failover — those are your errors to see, not the provider's.
- **Stock footage**: "Auto" now prefers the source that's actually up, and every Pexels/Pixabay search feeds the breaker.

Result: an AI-imagery video no longer fails because one image API had a bad five minutes — it quietly finishes on the next provider.

## 2. Post-render quality gate — customers never receive (or pay for) a broken video

Every video is verified **before** upload and before the job is marked succeeded (`lib/videoGen/qaGate.ts`):

- unplayable file (ffprobe can't decode it) → fail
- rendered length drifting >25% from the pipeline's target (truncated encodes) → fail
- picture black at every sampled point (signalstats; fades are tolerated because only *all four* samples dark fails) → fail
- silent or missing narration track on topic videos (volumedetect < −50 dB) → fail

A gate failure flows into the existing refund path — the tenant's credit comes back automatically, with a clear "you were not charged" message. Judgement checks are conservative and fail-soft on tooling hiccups, so a good video can't be rejected by a flaky check.

## 3. Scene diversity + music energy window — small edits, big feel

- **No back-to-back repeats**: when the vision ranker maps two adjacent sentences to the same clip, the second swaps to the least-used clip that differs from both neighbors. Deterministic, and skipped when there's only one clip.
- **Music starts where the music starts**: an ebur128 loudness scan finds where an uploaded track actually gets going, and slideshow + topic compositions seek past long quiet intros (keeping a 1s lead-in). Strictly fail-soft — any analysis hiccup plays from the top, exactly as before.

## 4. Real progress stages — the fake progress bar is gone

The busy card used to show a hardcoded 15%/60%. Now the pipeline reports what it's actually doing and the studio shows it live while polling:

> Writing the script… → Voicing the narration… → Finding the right footage… → Composing the video… → Running quality checks… → Saving to your library…

(Character mode says "Filming your character", AI imagery says "Creating AI imagery", slideshows say "Preparing your photos" / "Composing the slideshow".) The progress bar maps to real pipeline position. `VideoJob.stage` is in the API contract, so mobile can show the same thing whenever you want.

## Verified

- 106 api-server tests green (providerHealth breaker semantics, 6 failover scenarios, real-ffmpeg QA-gate fixtures — black/silent/truncated/unplayable — music-energy detection on a real quiet-intro track, all existing videoGen + routes suites)
- 11 video-studio page tests green (incl. live-stage rendering); root typecheck clean; spec lint clean; codegen committed; db push applied locally

## What's deliberately NOT in this patch

From the study, still open (each needs its own patch, say the word):

- **A1 word-timestamp captions** (ASR-timed karaoke-style subtitles) — the single biggest remaining quality jump
- **HyperFrames renderer bet** (declarative HTML timelines, Apache-2.0 dependency)
- **Model catalog as data** (Open-Generative-AI's pattern), music generation, avatar/talking-head, reference-video analyzer, brand→video compiler, wider stock sources (Openverse)
