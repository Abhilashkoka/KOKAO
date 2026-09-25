# KOKAO — App Walkthrough template

A saved character introduces the app on camera, the tenant's screen recording
plays under the voiceover, and the character comes back for the closing line.
An animated brand end card finishes the video.

```
[character intro, lip-synced] → [screen recording + voiceover] → [character closing, lip-synced] → [brand end card]
        3–6 s                          full recording, never trimmed              3–6 s                  3.5 s
```

This comes as five commits (the last adds this guide) in `app-walkthrough.patch`, based on
`feat/prompt-kit-script-variants` @ `cedcbc59`.

## Apply it

From the repo root in the Replit shell:

```bash
git apply --check app-walkthrough.patch   # dry run; prints nothing on success
git am app-walkthrough.patch              # applies as five commits

# then, from artifacts/api-server:
pnpm exec tsx scripts/seed-video-templates.ts   # adds the "App Walkthrough" template
```

You don't need to run `db push`. Every new field lives inside existing JSON
columns (`options.hybridStory.screenDemo` and the template `jobDefaults`).
Nothing new is installed, and the generated API clients are already in the
patch.

Once it's seeded, the template shows up in the Studio template picker. Admins
can also build their own version: in the template editor, set **Format type**
to **App walkthrough (screen recording)**.

## How to use it (tenant)

1. Pick **App Walkthrough** in the Studio.
2. Choose a saved character and outfit, and tick the lip-sync consent box.
3. Upload a screen recording: MP4, MOV or WebM, 5 s to 10 min, up to 100 MB.
4. **Script:**
   - **Write it for me** (default): the prompt box is a short brief, e.g. what
     the app does and what to highlight. KOKAO takes 6 frames from the
     recording and writes the script from them: a one-line intro, a
     step-by-step voiceover sized to the recording, and a one-line closing
     that names the brand.
   - **Use my script:** the prompt box is spoken word for word. The first
     sentence is the character's intro, the last sentence is the closing, and
     everything in between is the voiceover.
5. **Brand end card:** on by default. You can set a tagline (defaults to the
   brand kit tagline), a call to action, and an animation (fade up, logo
   scale-in, or slide in).
6. The storyboard review opens as it does for other hybrid templates. The
   voiceover text can be edited there before rendering.

## How it works

- **One voice all the way through.** The whole script is voiced as one TTS
  track, in the brand's cloned voice if there is one. Each character beat is
  lip-synced to its slice of that track. The demo beat uses the same track, so
  the voice never changes between the character and the voiceover.
- **Only the character beats cost money.** The demo beat re-encodes the
  tenant's own footage with ffmpeg and makes no provider calls. A job costs
  7 units: 1 for narration plus 3 for each character beat. At your current
  Atlas rate, about 8–10 s of paid video per job.
- **The recording is never trimmed**, in line with the repo's duration policy.
  - If the recording is longer than the voiceover, it keeps playing after the
    words stop (music continues underneath).
  - If it's shorter, its last frame holds until the voiceover finishes.
  - The demo beat's limit is `1.5 × recording + 10 s`. A script much longer
    than the footage is refused instead of freezing on one frame.
- **Letterboxed, not cropped.** A desktop recording in a 9:16 video, or a phone
  recording in 16:9, sits on a blurred copy of itself, so every part of the UI
  stays readable. The template defaults to 16:9.
- **The script is written once.** An auto script is saved to
  `options.hybridStory.screenDemo.generatedScript` before narration starts, so
  a retry uses the same words and doesn't pay for a second script.
- **Intro and closing stay intact.** The narration splitter merges fragments
  under 10 characters and splits sentences over 90. The script writer
  compensates for both, so demo words can't slip into a character line.
  User scripts are checked before funding: at least three sentences, and the
  first and last each under 90 characters.
- **The end card can't cost you the video.** If it fails, the job still
  delivers the rendered video without it and logs a warning.
- **The end card uses the brand kit:**
  - background: the first brand colour
  - text colour: dark or white, picked by contrast
  - logo: the full primary logo first, then the icon mark
  - name: the brand name

## Kill switch

`screenDemoVideo` ("App Walkthrough Videos") appears in the admin Feature
Controls card. When it's off:

- new walkthrough jobs get a 403 `feature_disabled`
- the Studio hides the upload and blocks generation

## Files

| File | What changed |
|---|---|
| `lib/videoGen/screenDemo.ts` | New. Recording probe, frame sampling, script writer and repair, demo fitting, end card render and append |
| `lib/videoGen/hybridStory.ts` | `screen_demo` counts as a mandatory body beat |
| `lib/videoGen/videoTemplates.ts` | Pattern grammar: one `screen_demo`, bound up to 600 s; `screen_recording` slot |
| `lib/videoGen/videoTemplateSeed.ts` | The "App Walkthrough" template |
| `lib/videoGen/units.ts` | `screen_demo` = 0 units |
| `lib/videoGen/jobRunner.ts` | Script resolution before planning, demo poster, demo render branch, end card |
| `lib/videoGen/branding.ts` | `primaryHex`, `tagline`, `logoPath` |
| `routes/videos.ts` | `screenDemo` request intake, validation before funding, snapshot |
| `lib/featureFlags.ts` | `screenDemoVideo` |
| `openapi.yaml` + generated | `ScreenDemoRequest`, `ScreenDemoEndCard`, new enum values, flag |
| `pages/video-studio.tsx` | Upload, script mode, end card controls |
| `pages/admin/video-templates-tab.tsx` | "App walkthrough" format type |

## Verified

- `pnpm run typecheck`: clean across all five projects.
- `redocly lint`: valid (the same 4 warnings as before).
- New tests, all passing:
  - `screenDemo.test.ts` (18): encodes real media and reads pixels back to
    prove letterboxing, no trimming, last-frame hold, all three card
    animations, and the append with audio.
  - `videoTemplates.test.ts` (2)
  - route tests in `videos.test.ts` (7): missing recording, wrong template,
    cross-tenant path, bad length with nothing charged, user-script check,
    kill switch, and the frozen snapshot.
- Existing suites fail exactly as they do on a clean checkout, with no new
  failures:
  - `videos.test.ts`: the same 26 tests
  - videoGen, featureFlags and admin: the same 4 tests
  - socialforge studio and admin: the same 1 test

  The shared failures come from the local environment (provider keys and
  ElevenLabs catalog). A fresh database also needs an
  `ai_cost_settings.usd_to_inr_paise` row, or every video price reads as
  unpriced.
- End-to-end composition: stand-in character clips, a portrait recording, a
  narration track, the real `composeTopicVideo` and the end card render
  cleanly into a single 1920×1080 video with audio.

## Not built

- **A job-runner integration test for the whole hybrid path.** The repo has no
  runner-level hybrid test to extend yet. The runner branches are small and
  reuse the tested pieces, but they have not been through a real provider run.
- **Zoom-on-click and a picture-in-picture character during the demo.** Both
  fit on top of `fitScreenDemoClip`.
- **Music under the end card.** The music bed fades out with the closing beat,
  and the card itself is silent.
