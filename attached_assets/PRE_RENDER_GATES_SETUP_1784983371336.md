# Patch 6 — Pre-render quality gates

`pre-render-gates.patch` · apply after `reference-analyzer.patch`

## Apply

```bash
git apply pre-render-gates.patch
```

No schema change, no OpenAPI change, no codegen, no new dependency, no UI change. Nothing to run after applying.

## What it does

The existing QA gate runs *after* the encode and catches broken video — black frames, silent audio, a truncated file. It cannot catch **boring**, because boring encodes perfectly. A topic video that comes out as one still image held over 40 seconds of narration passes every check you have today and still isn't worth posting.

This patch judges the scene layout *before* the encode, while the cut rhythm is still free to change.

`planGate.ts` is pure logic — no I/O, no network, no throws. It scores five things off data the pipeline already has: scene durations, how many distinct source clips are in play, narration sentence start times, and whether the visuals are real footage or generated stills under a Ken Burns move.

It behaves in this order:

**Repair.** Any scene held longer than 8 seconds gets split into equal cuts that rotate through the other available clips. Total scene time is preserved exactly, so the composition still lines up with the narration track. This is free and deterministic, and it's what happens to most weak plans.

**Warn.** What repair couldn't fix goes to the job log with the reasons ranked worst-first: a cut rate slower than the format allows (5s per cut for stills, 9s for footage — a Ken Burns push is not motion, so stills owe you more cuts), a single visual carrying more than four spoken sentences, or an overall slideshow risk at or above 0.5.

**Refuse.** Only at risk 0.85. Getting there arithmetically requires stills *and* a single clip *and* long holds *and* repetition all at once — a plan no amount of recutting can rescue. It fails through the existing `VideoGenProviderError` path, so the tenant gets their credits back and sees: *"This video came out as one repeated still held over the whole narration, which is not worth publishing. You were not charged — try a longer topic, more paragraphs, or stock footage."*

Refusing costs the tenant their already-spent script and narration budget even with the refund, so it's kept rare on purpose.

## Two decisions worth knowing about

**It scores the layout the composer will actually render, not the one handed to it.** `composeTopicVideo` already calls `diversifySceneClips` internally, so scoring the raw plan would flag adjacent repeats that are about to be fixed anyway. The gate diversifies first, then scores, then passes its own repaired `sceneMap` to the composer — which is the one behavioural change to `topicVideo/index.ts`: the composer now always receives an explicit scene map instead of sometimes computing its own.

**Slideshow rendering is deliberately not gated.** Someone who uploaded their own twelve photos must never be told their slideshow is too much like a slideshow. The gate is topic-engine-only.

The five risk dimensions and their weights: long hold 0.30, repetition 0.25, visual poverty 0.20, stillness 0.15, caption reliance 0.10. These are written for this pipeline — concepts were read from OpenMontage (AGPLv3), but no code, prompts, or thresholds were copied.

## Files

| | |
|---|---|
| `artifacts/api-server/src/lib/videoGen/planGate.ts` | new — the gate |
| `artifacts/api-server/src/lib/videoGen/planGate.test.ts` | new — 25 tests |
| `artifacts/api-server/src/lib/videoGen/topicVideo/index.ts` | modified — step 3b, three lines of wiring |

## Verified

Full api-server suite: **1287 tests passing** across 106 files. Typecheck clean across all 14 workspace projects. OpenAPI spec lint clean.

Tuning knobs, if you ever want them looser or tighter, are the exported constants at the top of `planGate.ts`: `LONG_HOLD_SEC`, `MAX_SECONDS_PER_CUT_STILLS`, `MAX_SECONDS_PER_CUT_FOOTAGE`, `MAX_CUES_PER_SCENE`, `BLOCK_RISK`.
