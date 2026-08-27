---
name: ffmpeg render pitfalls
description: Hard-won ffmpeg rules for still inputs, looping, alpha merges, xfade timing, output bounds, and encode budgets.
---

# ffmpeg render pitfalls

- **Pin `-framerate` on every still-image input.** ffmpeg's image demuxer defaults to 25fps while our filter chains retime to the shared FPS constant (30), silently shortening clips to 5/6 length. Any new renderer that feeds stills must pass `-framerate <FPS>` before `-i`.
- **Never use `-shortest` when a music bed is an input.** It ends the output at the first exhausted input (usually the music), truncating the video. Bound output length with `-t` instead.
- **Never use `-stream_loop -1` on tenant-supplied audio.** A file that opens but decodes to zero packets loops forever and dies at FFMPEG_TIMEOUT_MS. Use a counted loop: probe the bed with `probeDurationSec`, loop `ceil(totalSec/bedSec)` times, and don't loop an unprobeable bed at all. A guard on "probed duration is finite and positive" is NOT sufficient — truncated files can probe a confident duration and still decode nothing.
- **Do not trust muxed audio duration metadata after a long concat/video-filter encode.** A stream can report the full duration while containing multi-second packet gaps or ending early. Reset input PTS, loop/trim music in the audio graph, and remux the completed mix over the final visual stream in a separate stream-copy pass. Verify decoded cue windows, not only `ffprobe` duration.
- **A seek (`-ss`) and a loop must never coincide on the same input** — `-ss` is an input option re-applied on every loop iteration, shortening each repeat. Intro-skip offsets only apply to tracks longer than the video, which never need looping.
- **Keep the duration clamp inside the argv builder**, not the caller, so per-input `-t` and the output bound always agree.
- **Re-stamp FPS after `alphamerge` before feeding the result to `xfade`.** ffmpeg 7.1.1 drops the merged stream's constant-frame-rate metadata and `xfade` rejects it as rate `1/0`, even when both colour and mask inputs were already pinned to the target FPS.
- **Compensate for every `xfade` overlap when timestamps are absolute.** Chaining inputs of nominal lengths subtracts one fade duration per join and makes later beats end early. Extend each input after the first by the fade duration, while computing offsets against nominal accumulated time.
- `VideoGenNotConfiguredError` is TERMINAL in `isTransientVideoGenError` — a missing provider key must not walk the fallback chain or record circuit-breaker failures (3 failures opens the shared breaker for everyone).

**Why:** all of these shipped as silent truncation/hangs/breaker-poisoning bugs before the render-and-routing fixes; the QA gate's 25% drift tolerance hides moderate shortfalls.
**How to apply:** whenever adding or editing ffmpeg invocations in `lib/videoGen/` (slideshow, aiBroll, postprocess, compose) or extending the video provider fallback logic.

- **Scale the encode timeout with output length.** A flat 5-minute ffmpeg kill cap failed real production renders: the published autoscale machine has far less CPU than dev, and supersampled zoompan/crossfade encodes legitimately run slower than 15s of wall time per output second there. Heavy encodes (slideshow render, topic-video segments + final compose) pass `encodeBudgetMs(outputSec)` — floor 5min (env `FFMPEG_TIMEOUT_MS` overrides), 15s/output-second scaling, 30min cap. The cap exists only to reap hung processes; never let it kill a slow-but-progressing render.
