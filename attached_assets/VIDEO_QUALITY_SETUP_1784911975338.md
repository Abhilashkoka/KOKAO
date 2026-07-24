# KOKAO Video Engine — quality + reliability overhaul

Built against your current main (on top of the composer-v2 branch). Everything here is deterministic ffmpeg work or hardening — **zero new AI cost per video**, no new dependencies, no schema or contract changes.

## Apply it

```bash
git am video-quality.patch
```

(If you haven't applied `composer-v2.patch` yet, apply that first — this commit sits on top of it.) Restart the app. Nothing else to configure.

## What your videos gain

**Sound.** This is the biggest audible jump. Narration is loudness-normalized to a spoken-word target, and background music is now *actually ducked* — sidechain compression keyed on the voice pulls it down while someone speaks and lets it swell back in the pauses. Before, music sat at a static 20% for the whole video (inaudible or muddy, never right). The final mix is normalized to the ~-14 LUFS Instagram/TikTok/YouTube expect, so your videos stop sounding quieter than everyone else's.

**Motion.** Slideshows get a gentle Ken Burns move — alternating slow zoom in/out per photo, rendered on a supersampled frame so it's smooth — and photos now cover-fill the frame instead of sitting between black bars. Topic videos stop feeling like a loop: scenes seek into *different parts* of each stock clip instead of always replaying from the start, and cuts get a subtle dip-to-black so they read as edits, not jumps.

**Framing.** Raw AI clips are normalized to what the user actually asked for. Until now, WAN returned ~720p, MiniMax ignored the aspect ratio entirely, and Veo is 16:9-first — so a 9:16 reel request could ship as a landscape clip. Now every text/image/character clip is cover-cropped and scaled to the exact requested frame at 30fps (fail-soft: if normalization ever hiccups, the original clip ships rather than failing a paid generation).

**Thumbnails.** Poster frames are grabbed past the fade-in at up to 1080px wide (were 640px at 0.5s — often a half-faded frame).

## What gets more reliable

Replicate calls now retry with backoff on 429s and transient 5xxs (create and download), and the polling loop tolerates up to three consecutive transient failures instead of killing a multi-minute job on the first blip. TTS — which previously had no timeout at all — is bounded at 90s per sentence with one retry, so a hung narration call can never stall a 25-minute topic video until the deadline.

## Small UI addition

Topic videos with stock footage now show a **Footage source** picker (Auto / Pexels / Pixabay) — your backend already supported the choice; the UI just always sent "auto".

## Verified

- All 43 videoGen tests green — including your upstream topicVideo, character-scene, and slideshow suites running real ffmpeg encodes through the new filter graphs
- 5 new tests: aspect re-framing with real ffmpeg, fail-soft passthrough on garbage input, retry/no-retry/timeout semantics
- API server + web typecheck clean; video-studio page tests 9/9

## Worth doing next (not in this patch)

Real progress stages for long jobs (the progress bar is currently cosmetic), a script preview/edit step before character videos spend 4–12 units blind, and caching script+narration so a compose failure doesn't re-spend the TTS. Say the word.
