# Render and routing fixes — three defects in the video pipeline

`render-and-routing-fixes.patch` · apply after `provider-scoring-and-telemetry.patch` (`8a51cf9`)

## Apply

```bash
git apply render-and-routing-fixes.patch
pnpm -w run typecheck
pnpm --filter @workspace/api-server run test src/lib/videoGen
```

The test line needs `DATABASE_URL` in the environment like every api-server run
does — the suite's global setup checks the schema before any test executes.
These particular tests also spawn the real system `ffmpeg` rather than mocking
it, so they take a couple of minutes and they genuinely prove the encoder
behaves on the box you ran them on.

**No `db:push` and no codegen this time.** Nothing here touches the database or
the API contract: all three defects live inside the ffmpeg argument lists and
the error classifier in `artifacts/api-server/src/lib/videoGen/`, which no
schema column and no OpenAPI operation describes. The request and response
shapes a client sees are byte-for-byte what they were before — a slideshow just
comes out the length it was asked for. So `lib/db/src/schema/` and
`lib/api-spec/openapi.yaml` are untouched, the generated client is untouched,
and a codegen-drift check will pass without being run. No new dependency, no
new secret, no new feature flag; these are bug fixes, and putting a kill switch
on them would only preserve the bug.

## What it does

**A photo slideshow with background music came out as long as the music, not as
long as the slideshow.** Pick five photos at four seconds each, attach a
seven-second track from the music library, and you got a seven-second video with
three of your photos missing. The music was passed to ffmpeg as an ordinary
unlooped input and the encode carried `-shortest`, which ends the output when
the *first* input runs dry — and the shortest input was the music. Below about a
25% shortfall the render just shipped truncated; above it the post-render QA
gate caught the duration drift and failed the job, refunding the tenant *after*
paying for the whole encode. The bed is now looped enough times to cover the
video and `-shortest` is gone, leaving the `-t` output bound that was already
there to decide the length.

**Every slideshow and every AI b-roll clip was 5/6ths of its intended
length.** A three-second Ken Burns clip lasted 2.5 seconds and its zoom stopped
5/6ths of the way through the move. The cause is a default nobody states out
loud: ffmpeg's image demuxer feeds stills at 25fps, while the filter chain
retimes to the pipeline's 30, so five frames of every six survived. Slideshows
lost about 17% per slide, which nets out to a 6.7% total drift — comfortably
inside the QA gate's 25% tolerance, so it shipped short in silence for every
tenant. Above three seconds per slide it stopped being subtle: the crossfade
offsets are computed from the requested duration, so they overran the shortened
streams and threw away more than half the video. On the topic-video side, short
AI clips are exactly what makes the composer loop-fill a scene, which is the
mechanism behind the camera move that visibly restarts mid-scene. Both inputs
are now pinned with `-framerate` to the same `FPS` constant their filter chains
already used.

**A tenant with no Replicate token got three failed attempts and could break
video generation for everyone else.** `VideoGenNotConfiguredError` extends
`Error` rather than `VideoGenProviderError`, so it fell past every branch of
`isTransientVideoGenError` and hit the closing `return error instanceof Error`
— classified as a passing upstream hiccup. Consequently a missing key walked
all three models in the fallback chain, none of which could ever have worked
since they authenticate with the same credential resolved once outside the loop,
and recorded three failures against the *shared* `videogen:replicate` circuit
breaker. Three is exactly `FAILURES_TO_OPEN`, so one misconfigured tenant per
job was enough to open the breaker and turn later preflights into a misleading
503 — "the AI video provider is not responding right now" — for tenants who are
configured correctly. Classifying it as terminal delivers both halves at once:
the fallback loop rethrows a non-transient primary failure before it reaches the
recording call, and only records failures it classified as transient.

## Judgment calls

**The music loop is counted, not infinite.** `-stream_loop -1` is the obvious
way to cover the video, and it is a trap here. An input that *opens* cleanly but
decodes to zero packets — an interrupted upload, whose bytes are still a
tenant's own library object, and `/ai/generate-video` validates `musicPath` by
object-key prefix only — restarts the demuxer forever at no cost and never
produces the frame that would satisfy the `-t` bound, so the encode runs until
`FFMPEG_TIMEOUT_MS` and the job dies five minutes later as "Slideshow encoding
timed out." I reproduced that against the real binary: infinite loop, exit 124;
counted loop, exit 0 in seven seconds. The count is
`ceil(totalSec / musicDurationSec)`, which needs the bed's actual length, so
`renderSlideshow` now probes it with the `probeDurationSec` helper that already
existed in the same file and passes it in. A bed whose length ffprobe cannot
read is not looped at all — it plays once and stops, which is the old behaviour
minus the truncation.

I chose the counted loop over the narrower fix of "only loop when the probed
duration is finite and positive", because that guard is not sufficient: a
truncated MP4 audio file in my scratch tests probed as a confident `1.000000`
and still decoded to nothing, so it would have been looped infinitely and hung
anyway. A counted loop always reaches EOF regardless of what the file turns out
to contain.

**A seek and a loop can no longer coincide.** The intro-skip analyser only
returns a nonzero offset for a track *longer* than the video, and a track longer
than the video needs no loop, so the two are now mutually exclusive by
construction. That kills a live trap for free: `-ss` is an input option, and had
both ever applied to the same input, the seek would have been re-applied on
every loop iteration, silently shortening each repeat. There is a comment saying
so at the line where someone would otherwise reintroduce it.

**The duration clamp moved into the argv builder.** `MIN/MAX_SLIDE_SECONDS`
used to be applied in `renderSlideshow` before the builder was called, so
`buildSlideshowArgs` — now exported and directly testable — would happily emit
a per-input `-t` of 30 seconds alongside an output bound computed from the
10-second clamp, i.e. a timeline the encoder then truncates. Clamping inside
the builder makes the two agree for every caller and removed the local clamp
rather than adding a second one; net, it is less code.

**One test slot was repurposed rather than added to.** The existing
"adds no audio input at all when there is no music" assertion could not fail —
its `inputOptions` helper throws when the named input is absent, so it was
asserting on a path it never reached. It is now "never loops a bed whose length
ffprobe could not read", which exercises the same absence of a `-stream_loop`
for a case that actually occurs.

## Files

| | |
|---|---|
| `artifacts/api-server/src/lib/videoGen/slideshow.ts` | modified — argv extracted to the exported pure `buildSlideshowArgs`; counted music loop, `-shortest` dropped, `-framerate` pinned, clamp moved in, bed length probed |
| `artifacts/api-server/src/lib/videoGen/slideshow.test.ts` | modified — 13 tests (was 5): five argv assertions plus end-to-end renders for the music length, the frame rate and a bed that decodes to nothing |
| `artifacts/api-server/src/lib/videoGen/topicVideo/aiBroll.ts` | modified — argv extracted to the exported pure `buildStillToClipArgs`; `-framerate` pinned on the still input |
| `artifacts/api-server/src/lib/videoGen/topicVideo/aiBroll.test.ts` | modified — 5 tests (was 4): the still input's frame rate asserted without spawning an encoder |
| `artifacts/api-server/src/lib/videoGen/index.ts` | modified — one line: `VideoGenNotConfiguredError` classified as terminal in `isTransientVideoGenError` |
| `artifacts/api-server/src/lib/videoGen/videoFallback.test.ts` | modified — 10 tests (was 9): a missing token attempts one model and leaves provider health untouched |

Filtergraphs are unchanged in both renderers; the diff to them is the
`-framerate` input option and the extraction of argv assembly into a function.

## Verified

Full api-server suite: **1437 tests passing** across 114 files (352s) — the
1427 on the base commit plus the ten new tests in the three files above. Web
suite: **357 passing** across 39 files. The three touched test files run green
in isolation: **28 passing** across 3 files (was 18). `pnpm -w run typecheck`
exits 0 — clean across all five workspace projects that define one.
The patch was verified by checking out `8a51cf9` into a clean worktree and
running `git apply --check`, which reported all six files applying with no
fuzz.

Every fix was also mutation-tested: reverting each one in place makes exactly
the intended tests fail and nothing else. Worth knowing which test is load
bearing for which fix — reverting the music loop to `-stream_loop -1` leaves
"runs the full intended length when the music bed is shorter than the video"
passing, and only the new degenerate-bed test catches it, timing out at 60
seconds. Its timeout is deliberately far below the 5-minute
`FFMPEG_TIMEOUT_MS` so a regression surfaces as a failing test in a minute
rather than a stalled suite.

## Open items, and the one thing to eyeball on a live run

**Replicate's terminal `status: "failed"` is still classified as transient, on
purpose.** When a prediction is accepted and then fails during inference,
Replicate answers with HTTP 200 and a body saying `failed`; the provider raises
`VideoGenProviderError` with no `status`, and `isTransientVideoGenError` treats
a missing status as timeout- or network-shaped and therefore retryable. So a
prompt that a model rejects on content grounds still walks all three models and
still records three breaker failures — the same shape of problem the third fix
solves for missing credentials. I left it because separating "the model refused
this prompt" from "the model fell over" means pattern-matching Replicate's
free-text `error` string, and a heuristic that guesses wrong in the *other*
direction stops retrying failures that a retry would have fixed. That is a
deliberate design decision with its own tests, not a one-line classification
bug, and it does not belong in a patch about render lengths.

**The same infinite-loop hazard pre-exists in two other places.**
`mixMusicIntoVideo` (`postprocess.ts`) and the topic-video composer
(`compose.ts`) both use `-stream_loop -1` on a tenant-supplied music input, and
both are reachable with the same truncated bytes. Neither is fixed here: the
`postprocess.ts` path is fail-soft (it returns the original video on any ffmpeg
error, so the worst case is a five-minute stall and then a silent video rather
than a failed job), and the `compose.ts` path is gated behind narration, which
is a different code path with its own duration bookkeeping. Both deserve the
same counted-loop treatment; converting them means threading a probe through
two more call sites and re-verifying two more renderers, which is a patch of
its own.

Also worth recording: the blast radius of the third fix is narrower than it
first looks, because `preflightVideoJob` already blocks an unconfigured
video-gen job before funding. The breaker-poisoning story materialises when the
`providerResilience` kill switch is off — the route's preflight check fails
open via `.catch(() => true)` — or if the token disappears between enqueue and
run. The fix is still worth having: it is one line, and the misclassification
is wrong on its own terms.

**What to eyeball on Replit.** Generate one slideshow of four or five photos at
four seconds each with a music track from the library attached, and check the
duration of the file that lands in the media library against
`slides × slideSec − (slides − 1) × 0.5`. It should now match within a frame or
two; before this patch it matched the music instead. Then generate one
topic-to-video with `visualsSource: "ai"` and watch a single scene end to end:
the Ken Burns push should travel once, smoothly, from the start of the scene to
the end, with no visible snap back to the starting frame partway through. If
you see the snap, the b-roll clip is still coming back short and the composer is
still loop-filling it.
