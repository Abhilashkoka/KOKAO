---
name: Animate-photo framing & prompt transparency
description: Why user photos are padded (never cropped) before video generation, and how the aiPrompt field must be derived.
---

## Pad, never crop, user photos
Before an animate-photo generation, the source photo is fitted into the requested frame via `fitImageToAspect` (scale-to-fit over a blurred, darkened self-background). Applied at BOTH call sites: the direct image_to_video branch and the storyboard photo render path.
**Why:** providers reframe photos whose shape doesn't match the requested aspect, and normalizeVideo cover-crops the output again — faces near the edge get cut. Padding means the model composes for the frame and nothing is lost.
**How to apply:** any new path that sends a user-owned image to a video model should go through the same fit; it is fail-soft (returns the original on ffmpeg error).

## aiPrompt must mirror the provider-bound input
`VideoJob.aiPrompt` shows users the exact prompt sent to the model (user prompt + the compiledClipPrompt length suffix — no hidden rewriting). For storyboard-backed photo jobs the render actually uses `scenes[0].visual` + the CLAMPED scene duration, so aiPrompt derives from those, never from job.prompt/options.
**Why:** a transparency field that can diverge from reality is worse than none; an architect review caught exactly this drift.
