---
name: ffmpeg render pitfalls
description: Hard-won ffmpeg rules for the video pipeline — still-input framerate pinning, no -shortest with music beds, counted loops instead of -stream_loop -1.
---

# ffmpeg render pitfalls

- **Pin `-framerate` on every still-image input.** ffmpeg's image demuxer defaults to 25fps while our filter chains retime to the shared FPS constant (30), silently shortening clips to 5/6 length. Any new renderer that feeds stills must pass `-framerate <FPS>` before `-i`.
- **Never use `-shortest` when a music bed is an input.** It ends the output at the first exhausted input (usually the music), truncating the video. Bound output length with `-t` instead.
- **Never use `-stream_loop -1` on tenant-supplied audio.** A file that opens but decodes to zero packets loops forever and dies at FFMPEG_TIMEOUT_MS. Use a counted loop: probe the bed with `probeDurationSec`, loop `ceil(totalSec/bedSec)` times, and don't loop an unprobeable bed at all. A guard on "probed duration is finite and positive" is NOT sufficient — truncated files can probe a confident duration and still decode nothing.
- **A seek (`-ss`) and a loop must never coincide on the same input** — `-ss` is an input option re-applied on every loop iteration, shortening each repeat. Intro-skip offsets only apply to tracks longer than the video, which never need looping.
- **Keep the duration clamp inside the argv builder**, not the caller, so per-input `-t` and the output bound always agree.
- `VideoGenNotConfiguredError` is TERMINAL in `isTransientVideoGenError` — a missing provider key must not walk the fallback chain or record circuit-breaker failures (3 failures opens the shared breaker for everyone).

**Why:** all of these shipped as silent truncation/hangs/breaker-poisoning bugs before the render-and-routing fixes; the QA gate's 25% drift tolerance hides moderate shortfalls.
**How to apply:** whenever adding or editing ffmpeg invocations in `lib/videoGen/` (slideshow, aiBroll, postprocess, compose) or extending the video provider fallback logic.

- **Scale the encode timeout with output length.** A flat 5-minute ffmpeg kill cap failed real production renders: the published autoscale machine has far less CPU than dev, and supersampled zoompan/crossfade encodes legitimately run slower than 15s of wall time per output second there. Heavy encodes (slideshow render, topic-video segments + final compose) pass `encodeBudgetMs(outputSec)` — floor 5min (env `FFMPEG_TIMEOUT_MS` overrides), 15s/output-second scaling, 30min cap. The cap exists only to reap hung processes; never let it kill a slow-but-progressing render.
