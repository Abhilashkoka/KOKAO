# reference-analyzer.patch — setup

Patch 5 of 5. Apply this **after** `brand-video.patch`.

## Apply

```bash
git apply --check reference-analyzer.patch   # dry run
git am reference-analyzer.patch              # or: git apply
```

## After applying

```bash
pnpm install
pnpm db:push        # REQUIRED — new table: video_style_profiles
pnpm --filter @workspace/api-spec run codegen
```

The codegen step is already baked into the patch (generated clients are
committed), so it only matters if you regenerate. `pnpm db:push` is **not**
optional this time — the new table has to exist before the route works.

## What it does

Upload a video whose rhythm you like. KOKAO reads it once and saves a *style
profile* you can attach to any topic video, instead of re-describing the pacing
you want every time.

The analysis splits into two halves on purpose:

**Measured** — ffmpeg probes the duration, extracts a mono 16 kHz mp3 of the
first 3 minutes, and the existing ASR provider transcribes it. Duration and
words-per-minute come from those facts.

**Described** — six frames sampled at the midpoints of six equal slices (so
fades and end cards never dominate) go to one vision call, which returns hook
shape, scene count, caption treatment, energy, framing notes, and 2–3 sentences
of script guidance.

The model is never allowed to supply the numbers. Whatever it says about
duration or speaking pace is discarded and replaced with the measured values,
so a profile can't drift into invention.

Applying a profile injects a `## Reference style` block into the topic script
prompt, right alongside the brand voice block. Both compose — a branded video
with a reference style gets your voice *and* the reference's structure.

In the studio, the topic engine gains a **Reference style** picker next to the
brand kit, with a **Styles** button that opens the manager (upload, name,
analyze, delete). Picking a profile adopts its caption treatment as a starting
point; a reference with no burned-in text turns subtitles off. Both stay
editable — the profile suggests, it doesn't lock.

## What a profile deliberately does not carry

The reference's footage, audio, music, or wording. The analysis prompt asks for
structure, pacing, framing, and caption treatment only, and explicitly forbids
describing the subject matter, brand, or wording of that specific video. A
profile describes *how* a video is built, never *what* it says — so applying one
cannot reproduce someone else's content.

References are **uploads only**. There is no URL ingestion, so nothing is ever
fetched from a third-party host.

## Fail-soft table

| Situation | Behaviour |
|---|---|
| Reference has no audio track | Visual-only profile, `wordsPerMinute: 0` |
| No ASR provider configured | Same — visual-only, analysis still succeeds |
| A single frame fails to extract | That frame is skipped, the rest are analyzed |
| Style profile deleted after a job was queued | Video renders without reference styling |
| Style profile id belongs to another workspace | Ignored (tenant-scoped lookup), renders unstyled |
| File isn't readable as video | 422, caption unit refunded, nothing saved |
| Vision reply unusable (no hook, no guidance) | 422, caption unit refunded — a blank profile is worse than none |
| Text model isn't vision-capable | 422 telling you exactly that |
| No text provider configured | 503 |

The split is deliberate: anything that still leaves a *useful* profile keeps
going, anything that would save noise fails loudly and gives the unit back.

## Cost

**One caption unit per analysis** — it's a single text-model completion, the same
shape of call the caption endpoints meter. Monthly quota first, then a caption
credit. Generating a video from a profile costs nothing extra; the profile is
just prompt text.

The upload is downloaded and size-checked *before* funding is reserved, so a bad
path or an oversized file never burns a unit.

Limits: 200 MB per reference, 8 saved styles per workspace, first 3 minutes
analyzed, 1 hour hard maximum.

## Files

New:

- `lib/db/src/schema/videoStyleProfiles.ts` — the `video_style_profiles` table
- `artifacts/api-server/src/lib/videoGen/referenceAnalyzer.ts` — the analyzer
- `artifacts/api-server/src/routes/videoStyles.ts` — GET / POST / DELETE
- `artifacts/api-server/src/lib/videoGen/referenceAnalyzer.test.ts`
- `artifacts/api-server/src/routes/videoStyles.test.ts`

Changed:

- `lib/api-spec/openapi.yaml` — `/ai/video-styles` paths + schemas, `styleProfileId` on generate
- `artifacts/api-server/src/routes/index.ts` — mounts the router behind the `videoGen` flag
- `artifacts/api-server/src/routes/videos.ts` — persists `styleProfileId` (topic engine only)
- `artifacts/api-server/src/lib/videoGen/jobRunner.ts` — resolves the profile, fail-soft
- `artifacts/api-server/src/lib/videoGen/topicVideo/{index,script}.ts` — the prompt block
- `artifacts/socialforge/src/pages/video-studio.tsx` — picker + manager dialog

## Verified before shipping

- `pnpm run typecheck` — clean across all 14 workspace projects
- api-server suite — 1262 tests, 105 files, all passing
- socialforge suite — 340 tests, 38 files, all passing
- `pnpm --filter @workspace/api-spec run lint:spec` — valid

## One thing to try

Save one profile from a video you know works, then generate the same topic twice
— once with the profile, once without. The difference shows up in sentence
length and where the hook lands, not in the words. That's the point: it's
borrowing the rhythm, not the content.
