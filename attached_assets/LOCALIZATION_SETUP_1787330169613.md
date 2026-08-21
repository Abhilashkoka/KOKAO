# KOKAO — Video Localization (Telugu, Tamil, Hindi)

## Apply it

From the repo root in the Replit shell:

```bash
git apply --check kokao-localization.patch   # dry run — prints nothing on success
git am kokao-localization.patch              # applies as three separate commits
```

Three commits, so you can test between them. No `db push` needed — this patch
adds no tables or columns. No new npm dependencies.

Generated API clients are included, so the codegen drift check passes as-is.

## What landed

**1. `lib/localization`** — a new shared workspace package (no dependencies, no
I/O) that the web app, mobile app and API server all import, so a transcreated
line is judged the same way everywhere.

- Per-locale editorial policy: how much English belongs in the *read* versus in
  *writing*, which differs sharply by language.
- Syllable estimation with Hindi schwa deletion, because on a locked cut the
  constraint is duration and duration tracks syllables, not words.
- Subtitle limits and validation (42 chars/line, 2 lines, 22 cps), bottom-heavy
  wrapping, orphan-line detection.
- SRT and WebVTT, written without a byte-order mark.
- Lint: English left in Latin letters inside an Indic line, textbook coinages,
  and brand or interface terms that got translated when they had to stay put.

**2. `POST /ai/localize-script` + a "Languages" tab in AI Studio**
(`/studio?tab=localize`)

Upload an SRT or paste a script with a runtime. Get back, per language: the
transcreated lines, syllables against budget, a blind back-translation, every
mechanical issue found, and downloadable SRT/VTT.

One caption credit per language, on the existing quota→credit rail. Reserved up
front, refunded per language, so a Tamil timeout can't cost you the Hindi track.
New `videoLocalization` kill switch, stacked under the Video Studio switch.

**3. Dubbing foundations**

- ASR now returns segment timestamps across all four providers, behind an opt-in
  flag so the voice-note button is unaffected.
- `lib/localization/dub.ts`: Indic subtitle burn-in via libass, audio fitting,
  track assembly, audio replacement.
- `replit.nix` gains `fontconfig` + Noto fonts.

## Two things worth knowing

**Your caption compositor will break Indic text.**
`videoGen/topicVideo/compose.ts` burns captions with ffmpeg's `drawtext`, which
renders through libfreetype with no complex-script shaping. Telugu and Tamil
conjuncts come out reordered; Devanagari matras detach from the shirorekha. For
Latin the two are indistinguishable, which is why this survives review. The new
`dub.ts` uses the `subtitles` filter (libass → HarfBuzz) instead. If you ever
put Indic text through the existing topic-video captions, route it through
`burnSubtitles` instead.

**fontconfig never fails, so the renderer verifies.**
`fc-match ":lang=ta"` returns FreeSans even on a box with Noto Sans Tamil
installed. `resolveSubtitleFont` asks by family name and checks what came back,
raising `MissingIndicFontError` rather than rendering tofu.

## Verified

- `pnpm run typecheck` — clean across all five projects
- `pnpm run test` — 3551 pass. 112 of those are new (52 lib, 12+21+19 server,
  8 web). The ffmpeg tests encode real media and skip cleanly where ffmpeg or
  the Indic fonts are absent.
- `redocly lint` — clean
- codegen drift — clean
- `git am` — applies cleanly onto a fresh checkout

One pre-existing failure, unrelated and not touched by this patch:
`routes/ads.meta-reconnect.test.ts` needs Meta OAuth app credentials in the
environment.

## Not built yet

The render half. What exists is every piece it needs; what's missing is the
wiring:

1. **A TTS provider that speaks these languages.** Your `TTS_PROVIDERS` registry
   (`videoGen/topicVideo/tts.ts`) has OpenAI and Deepgram Aura, all `-en`
   voices, and `speak()` takes no language argument. Sarvam (Bulbul) is the
   Indic-specialist choice you picked — adding it means extending that signature
   with a language parameter and adding one registry entry. I did not write it
   because I could not reach Sarvam's API docs to confirm the exact request
   shape, and an unverified vendor integration is code that looks finished and
   isn't. Worth noting: `voiceClone/index.ts` already sends ElevenLabs
   `eleven_multilingual_v2` and never passes a language — that capability is
   sitting there unused, and is the cheaper first move if you want to test the
   pipeline before signing up with anyone.

2. **`engine: "localize"` on `video_generations`.** The job table, the atomic
   claim, the stage-progress polling, the sweeps and the funding reserve/settle
   all work as-is; this is a new branch in `jobRunner.ts` plus validation in
   `routes/videos.ts`. The pipeline itself is: extract audio → ASR with
   timestamps → transcreate → TTS → `planAudioFit` per cue → `assembleDubTrack`
   → `replaceAudio` → optional `burnSubtitles` → upload → save to library.

3. **A "render this" button.** The Languages tab is already the review step —
   the user approves the script there before anything expensive runs — so the
   job takes approved cues and needs no `awaiting_review` pause.
