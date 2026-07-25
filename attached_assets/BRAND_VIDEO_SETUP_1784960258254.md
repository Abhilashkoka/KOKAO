# brand-video.patch — Patch 4 of 5

Brand kits now steer topic videos: brand voice in the script, brand colour on
the captions, brand logo on every frame.

## Order

Apply **after** `viral-toolkit.patch`. Full sequence:

1. reliability-core.patch
2. captions.patch
3. music-suite.patch
4. viral-toolkit.patch
5. **brand-video.patch  ← this one**

## Apply

```bash
git apply --check brand-video.patch   # dry run
git apply brand-video.patch
```

Or, to keep the commit message:

```bash
git am brand-video.patch
```

## After applying

```bash
pnpm install                 # no new deps, but keeps the store honest
pnpm db:push                 # no schema change; safe no-op
pnpm run typecheck
```

The generated API client and zod files are **included in the patch**, so you do
not need to re-run codegen. If you prefer to regenerate:

```bash
pnpm --filter @workspace/api-spec run lint:spec
pnpm --filter @workspace/api-spec run codegen
```

No database migration. `brandKitId` lives inside the existing
`video_generations.options` JSON column.

## What it does

**Brand voice in the script.** When a job carries a `brandKitId`, the script
prompt gains a `## Brand voice` block built from the kit: voice traits,
audience, CTA style, and a hard "never use these terms" line from the kit's
restricted terms. The output contract (paragraph count, `searchTerms`) is
untouched — branding only changes how it reads.

**Brand colour on captions.** The first parseable swatch (primary before
secondary) is darkened to 45% luminance and used as the `drawtext` stroke
colour, so white caption text keeps its contrast while picking up the brand
hue. Works with both `classic` and `dynamic` caption styles.

**Brand logo on frames.** The kit's icon mark is preferred, then the primary
logo, then the secondary. It is scaled to ~7% of frame height, composited at
85% opacity in the top-right corner — deliberately clear of both caption
positions.

**Where you pick it.** Video Studio → Topic to Video → *Brand kit (optional)*
(`select-brand-kit`). Defaults to "No branding". The picker only appears on the
topic engine; other engines send `brandKitId: null`, and the server drops it
anyway.

## Fail-soft, by design

Nothing about branding can fail a render:

| Situation | Result |
|---|---|
| No `brandKitId` | Identical output to before this patch |
| Kit belongs to another tenant / does not exist | Renders unbranded |
| Kit has no colours, or only unparseable ones | Default black caption stroke |
| Kit has no logo | No watermark |
| Logo bytes fail to load from storage | Warn, skip watermark, keep rendering |
| Logo is an external `https://` URL | Ignored on purpose (see below) |

**Why external logo URLs are ignored:** watermarking from an arbitrary URL
would mean the render worker fetches a third-party host on every job, which is
an SSRF surface and a reliability dependency. Only `/objects/...` paths inside
the tenant's own storage are loaded. If a brand kit's logo is an external URL,
upload the logo through the brand kit UI to get it watermarked.

## Cost

Free. Branding adds no generation calls, so a branded video costs exactly the
same number of video units as an unbranded one.

## Files

New:

- `artifacts/api-server/src/lib/videoGen/branding.ts` — resolves a kit into
  `{ voiceHint, accentColor, watermarkPath, brandName }`
- `artifacts/api-server/src/lib/videoGen/branding.test.ts` — 13 tests

Changed:

- `lib/videoGen/topicVideo/script.ts` — optional `brandVoice` in the prompt
- `lib/videoGen/topicVideo/compose.ts` — `accentColor` stroke + `watermark`
  overlay chain
- `lib/videoGen/topicVideo/index.ts` — threads all three through
- `lib/videoGen/jobRunner.ts` — loads branding + logo bytes, fail-soft
- `routes/videos.ts` — persists `brandKitId` for topic videos only
- `lib/db/src/schema/videoGenerations.ts` — `VideoJobOptions.brandKitId`
- `lib/api-spec/openapi.yaml` + generated client/zod
- `artifacts/socialforge/src/pages/video-studio.tsx` — the picker

## Verified before shipping

- `pnpm run typecheck` — clean across all 14 workspace projects
- api-server: **1228 tests / 103 files passing** (full suite, not just the new
  ones), including 2 real-ffmpeg renders of a branded video
- socialforge: **16 video-studio tests passing**
- `lint:spec` — valid

## One thing to try

Open a brand kit, make sure it has an uploaded logo and at least one hex
colour, then render a 1-paragraph topic video with that kit selected. Compare
it to the same topic with "No branding" — same length, same cost, but the
narration voice, caption outline, and corner mark are all yours.
