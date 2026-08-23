# KOKAO — Spokesperson + B-roll format

Everything needed to render the "expert talks while related footage plays above
him" format, plus the template system tenants pick it from.

Four commits in `kokao-broll-composite.patch`.

## Apply it

From the repo root in the Replit shell:

```bash
git apply --check kokao-broll-composite.patch   # dry run — prints nothing on success
git am kokao-broll-composite.patch              # applies as four commits
pnpm --filter @workspace/db run push            # commit 3 adds columns
```

The `db push` is required this time — commit 3 widens `video_style_profiles`.
Changes are additive: `tenant_id` becomes nullable, five new columns arrive with
defaults. No backfill, no data loss.

No new npm dependencies. Generated API clients are included, so the codegen
drift check passes as applied.

---

## Commit 1 — the compositing pass

`artifacts/api-server/src/lib/videoGen/brollOverlay.ts`

Takes a presenter video and a list of `{file, startMs, endMs, opacity}` and
returns the finished video. No AI, no network — pure ffmpeg.

**The overlay is one continuous track, not N overlays.** Beats are alpha-merged
with a feathered ramp, chained with `xfade`, and composited once. Overlaying
each beat separately washes every transition: at the midpoint both layers sit
semi-transparent over the plate and the base bleeds through.

**Gaps are transparent filler clips.** `xfade` has no concept of a hole, and
this format needs one — the reference drops its overlay near the end so the
presenter lands the closing line unassisted.

**The bottom edge is feathered per beat, at that beat's opacity.** A hard edge
reads as picture-in-picture; the ramp is what makes it read as one image. Alpha
comes from a greyscale ramp rasterised through `sharp` — the same path the
watermark uses — rather than `geq`, which would evaluate a per-pixel expression
on every frame for a mask that never changes.

`planBeatTrack` is pure and carries most of the tests, because chained `xfade`
offsets are arithmetic that looks right and renders wrong: each join shortens
the timeline by one crossfade, so offsets accumulate against the running total.

Defaults measured from a real reference: overlay across the top 45% of frame,
bottom 18% of the box feathered, 700ms dissolves.

## Commit 2 — the beat planner

`artifacts/api-server/src/lib/videoGen/beatPlanner.ts`

Decides what appears above the presenter and when. Does not write copy — the
narration is the presenter's own take.

**The model is asked for narration line ranges, never milliseconds.** Hand a
model timecodes and it returns a beat from 6.4s to 13.1s that cuts a sentence in
half. Asking which lines a beat covers makes timings fall out of the script's
own arithmetic, so a beat cannot start mid-sentence by construction.

**Opacity is a lookup keyed on visual kind**, not a model decision. Graphics
solid, lifestyle footage ghosted so the presenter is never hidden behind a
stranger's face.

`repairBeats` enforces everything: snaps to line boundaries, merges beats under
4s into their predecessor, splits beats over 12s on the line boundary nearest
the midpoint, drops overlaps and phantom line numbers, and always frees the
closing line. Every change lands in `notes`, so the review UI can say "merged a
2.1s beat" instead of silently producing something else.

### Seeding the prompt template

Nothing manual. The patch registers a `broll-beat-plan` case in
`promptKitSeeds.ts` under the new `video_broll_beats` flow key, so your existing
`scripts/seed-prompt-kit.ts` creates the case type, template and first version
on the next run.

The blocks live in `beatPlanner.ts` and the seed imports them, so the seeded
version cannot drift from the prompt the planner actually compiles. After
seeding, changing how beats get chosen is a content edit in the admin UI with
review and rollback — not a deploy.

## Commit 3 — templates

`artifacts/api-server/src/lib/videoGen/videoTemplates.ts`

A template is a **format**, never a video. The tenant always brings the content.
If a template carried content, every workspace would ship the same video.

Curated templates and a workspace's own style profiles are therefore the same
object with different owners, and share `video_style_profiles`. The existing
`GET /ai/video-styles` now returns a workspace's own rows plus every published
platform template — one list, one shape, one code path.

**Cross-tenant safety is the point of the module.** A platform template may
never reference tenant assets: `characterId`, `brandKitId`, `styleProfileId` and
any `/objects/<tenantId>/` path are meaningless elsewhere. `TemplateJobDefaults`
is typed as `Omit<VideoJobOptions, …those keys>` so the mistake cannot be
written; `assertTemplateSafe` catches rows loaded from the database, where no
type protects them. On the list path an unsafe row is dropped and logged rather
than thrown — one bad template hides itself instead of taking the picker down.

Deletion needed no new guard: the route already filters on `tenantId`, and
`NULL = value` is never true in Postgres.

**Slots** declare what the tenant must supply, shown *before* selection. A card
that looks free and then demands a shoot is the worst possible ordering. The
presenter slot carries the framing constraint that actually bites — head and
shoulders in the lower two-thirds, because the overlay occupies the top of frame.

**Cost on the card.** `shotCount` drives the funding reservation, so a template
quietly costing eight units per run generates support tickets.

---

## Verified

- `pnpm run typecheck` — clean across all five projects
- Full api-server suite: **2302 of 2303 pass**. 81 of those are new across the
  four commits. The single failure is `ads.meta-reconnect`, which needs Meta
  OAuth app credentials in the environment and fails identically on a clean
  checkout.
- `redocly lint` — clean
- codegen drift — clean
- `db push` — applied against a real Postgres 16
- `git am` — applies cleanly onto a fresh checkout

The ffmpeg tests encode real media and read pixels back rather than asserting on
argument strings. They skip cleanly where ffmpeg is absent.

---

## Two bugs worth knowing about

Both were hit while building a sample video, and both will hit you too.

**Presenter framing.** If the subject's head starts above ~40% of frame height,
the overlay lands on their face. The reference has the doctor seated low, head
starting around 35%. Hence the framing hint on the presenter slot — but consider
also rejecting footage at upload rather than after the render.

**libass coordinate space.** Burning an SRT with `force_style` leaves the
subtitle script's `PlayResY` at 288, so `FontSize` and `MarginV` get scaled by
roughly 4.4× against a 1280-tall frame — giant text pinned to the top. Generate a
real ASS file with `PlayResX`/`PlayResY` set to the actual frame size. The same
trap applies to the localization subtitle burn.

---

## Not built

**The render engine.** No `engine: "localize"` or `engine: "spokesperson"` on
`video_generations` yet. The job table, atomic claim, stage polling, sweeps and
funding all work as-is; this is a new branch in `jobRunner.ts` plus route
validation.

**The b-roll fetch step.** The planner returns a `query` per beat; something has
to turn that into a file. Your `topic_to_video` already searches Pexels and
Pixabay per scene — that logic points at this directly.

**TTS.** Nothing in `TTS_PROVIDERS` can speak Telugu, Tamil or Hindi; every voice
is `-en` and `speak()` takes no language argument. Until that changes the
pipeline produces silent video with burned captions. Cheapest first move:
`voiceClone/index.ts` already sends ElevenLabs `eleven_multilingual_v2` and never
passes a language — that capability is sitting unused.

**Any actual curated template row.** The table can hold one and the endpoint
would return it, but nothing in the patch creates a `scope: 'platform'` row —
so the picker would open empty. Needs a seed or admin CRUD.

**Superadmin CRUD for curated templates**, and the three-tab picker UI
(Curated / Yours / From your best). The list endpoint already returns everything
all three tabs need.

---

## Reference profile

Measured from a 95.6s vertical explainer, for calibration:

| | |
|---|---|
| Format | 720×1280, 9:16, 30fps |
| Cuts | none — one continuous take |
| B-roll beats | ~12, averaging 8s |
| Overlay region | top 45% of frame, soft-feathered |
| Speech rate | 3.22 syllables/sec |
| Audio | −14 LUFS integrated, 1.9 LU range |
| Captions | two lines, ~78% down frame, previous line dimmed, current bold |

One observation worth carrying into the template design: the captions were
romanized Telugu in Latin script, not Telugu script. That is a real convention
for informal phone-first explainers, and it conflicts with the localization
playbook's rule of writing loanwords in the target script. Both are correct for
their register — so romanized should be a caption-style option, not a lint error.
