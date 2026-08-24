# KOKAO Video Upgrades — integration guide

Three patches that close the gaps between KOKAO's video engine and Open
Higgsfield AI, built to match your existing patterns: contract-first API,
provider registry, quota→credit→wallet funding, kill switches, tenant scoping.

Base commit: **`8138eab`**. Apply them in order.

---

## Apply it

In the Replit shell, from the repo root:

```bash
# dry runs — each should print nothing
git apply --check 0001-video-camera-moves-aspects-seeds.patch

git am 0001-video-camera-moves-aspects-seeds.patch
git am 0002-video-model-catalog-and-billing.patch
git am 0003-video-optics-portrait-lipsync-end-frames.patch
```

(If `git am` complains, `git apply <file>` then commit normally.)

Then, once — patches 2 and 3 each add one nullable column:

```bash
pnpm --filter @workspace/db run push
```

No new npm dependencies. Generated API clients are included in each patch, so
the codegen drift check passes without running anything.

**Rolling back one patch** is `git revert <sha>`; they are independent commits
in dependency order, so reverting 3 leaves 1 and 2 working, and reverting 2
also requires reverting 3.

---

## What each patch does

### 1 — Camera moves, the frames people publish in, seeds

Every AI clip received the same seven words (`"Subtle natural motion,
cinematic."`). Now there is a vocabulary.

- **Motion presets** — a curated catalog of named camera moves, each a label
  plus the prompt sentence it compiles to. Set per job and overridable **per
  shot** on a storyboard scene, which is the thing Higgsfield's single prompt
  box cannot do.
- **Aspect ratios** — adds `4:5`, `4:3`, `3:4`, `21:9`. 4:5 is the sharp
  omission for a social product: it is the Instagram feed ratio. No model
  renders 4:5, so a ratio the chosen model cannot produce is requested as the
  nearest one it can and cover-cropped to the exact frame by the normalize
  pass that already runs. The delivered file always matches the request.
- **Seeds** — optional, per job and per shot, so the same prompt renders the
  same way twice. Sent only to model families whose schema carries a seed:
  Replicate 422s on unknown keys and a 422 costs a paid video unit.

New endpoint: `GET /ai/video-motion-presets`.

**Configuration: none.** Works the moment it is applied.

### 2 — Model catalog, capability-driven controls, billing

A superadmin picked one text-to-video and one image-to-video model for the
whole platform, and the duration slider was silently clamped downstream — a
7-second Kling request came back at 5 with the last frame frozen to pad it.

- **`lib/videoGen/modelCatalog.ts`** is now the single source of truth for what
  each model does: modes, durations, aspect ratios, resolutions, quality
  switch, native audio. The studio renders only the controls a model supports,
  preflight refuses an impossible request before funding, and the provider
  adapters stop sniffing model-name substrings.
- **Per-generation model choice** — `modelId` on the request; `GET
  /ai/video-models` returns what this workspace can actually pick.
- **Resolution and quality tiers**, and `generateAudio` for Veo.
- **Billing** — see the next section.

New endpoint: `GET /ai/video-models`.

### 3 — Optics, portrait lip sync, end frames

- **Cinematography** — camera body, lens, focal length, aperture. Independent
  of motion presets, and every axis independently optional.
- **Lip sync: bring your own audio** — upload a real recording and it speaks
  instead of the synthesiser, on both modes. The script becomes optional.
- **Lip sync: portrait mode** — one headshot plus audio becomes a talking
  video. **Needs configuration** (below).
- **End frames** — `image_to_video` takes an optional second photo as the last
  frame. Gated on a catalog capability, and if a model rejects the request with
  an end frame attached it is retried once without: the user still gets the
  video they paid for.

New endpoint: `GET /ai/video-cinematography`.

---

## Billing

**Nothing about existing pricing moves.** A job with no `modelId` costs exactly
what it costs today, on both rails. Everything here is opt-in.

### The quota / credit rail

A picked model carries a **tier multiplier**, applied to the *generation
count*:

| Tier | Multiplier | Models |
|---|---|---|
| Draft | 1× | WAN 2.2 Fast, Kling 3.0 Standard, Seedance 2.0 Fast |
| Standard | 2× | WAN 2.5, WAN 2.7, Kling 2.1 Standard, Seedance 1 Pro, Seedance 2.0, Hailuo 02, Hailuo 3 |
| Premium | 4× | Veo 3, Veo 3 Fast, Veo 3.1, Veo 3.1 Fast, Kling 2.1 Master, Kling 3.0 Pro, Sora 2 Pro |

A four-shot premium clip is **16 units**, because it really is sixteen premium
generations' worth of provider spend. `GET /ai/video-models` reports each
model's `unitMultiplier` so the studio can show the price before the user
commits — it already does.

Resolution deliberately does **not** change the unit price: a cheaper tier is a
faster render, not a cheaper one, and fractional units would break a quota
model built on whole numbers.

Every path that recomputes a price goes through
`videoJobUnits(engine, options)` — the route's reservation, the runner's usage
rows and refunds, the stuck-job sweep, storyboard discard — so the two rails
cannot drift. The scene-insert route now reserves the multiplier too; a flat
unit there against a multiplied recomputation elsewhere is how a refund quietly
hands back more than was taken.

### The wallet rail

Unchanged in behaviour: reserve an estimate at the admin display rate, settle
at the real provider cost from the price catalog via `computeVideoCostPaise`.
The multiplier only sizes the reservation, so a premium job reserves enough and
settles down to what it actually cost.

### What you should do after applying

1. **Add price rows** for any catalog model you enable, in
   Admin → AI → cost catalog (`/admin/ai-cost/prices`, kind `video`). Without a
   price row a wallet job settles at the display rate and is flagged
   `estimated` in the ledger — it still works, it is just less accurate. Adding
   the price later collects the difference automatically.
2. **Decide the allowlist.** By default every catalog model is offered to
   tenants whose provider has a key saved. Narrow it with `enabledModelIds` on
   `PUT /admin/video-gen-settings`; an empty array turns per-generation choice
   off entirely and every job runs on the platform selection, exactly as today.
3. **Review the tier multipliers** in `lib/videoGen/modelCatalog.ts`
   (`TIER_UNIT_MULTIPLIER`). They are deliberately coarse — three buckets a
   user can reason about — and they are one constant to change.

There is **no plan gating**: any tenant can reach any enabled model, and the
multiplier is the only brake. That was a deliberate choice. If you later want
free tenants held to draft models, there is one place to add it —
`availableVideoModels()` in `lib/videoGen/index.ts`, which both the tenant
endpoint and the request validation call. Give it a plan argument, filter by
`tier`, and both the picker and the 400 follow automatically.

---

## Configuration

### Nothing required for patches 1 and 2

Both work against whatever provider you already have configured. Patch 2 offers
tenants only the models whose provider has a key saved, so with just
`REPLICATE_API_TOKEN` set they see the eight Replicate models and none of the
OpenRouter ones.

### Portrait lip sync (patch 3) — one setting

Video-mode lip sync is pinned to LatentSync in source and needs nothing.
Portrait mode needs a model that takes an **image** plus audio, and this patch
deliberately pins none: a guessed Replicate slug and version hash would 404 on
the first paid job.

Set it once, via `PUT /admin/video-gen-settings`:

```json
{ "provider": "replicate", "lipSyncPortraitModel": "owner/model-name:VERSION_HASH" }
```

- An **official** Replicate model is just `owner/model-name`.
- A **community** model needs the version hash appended after a colon —
  community models must be invoked through `/v1/predictions` with an explicit
  version, and the official-model endpoint 404s for them. Get the hash from
  `https://api.replicate.com/v1/models/<owner>/<name>` (the `latest_version.id`
  field), the same way `REPLICATE_LIP_SYNC_VERSION` was obtained.

The model must accept `image` and `audio` input keys; if it names them
differently, adjust `portraitLipSyncModel()` in
`lib/videoGen/lipSyncModels.ts` — it is four lines.

Until it is set, portrait jobs are refused at preflight with an actionable
message and **nothing is charged**. Video-mode lip sync is unaffected.

### Optional: OpenRouter

Nine of the seventeen catalog models are served through OpenRouter. Save an
`OPENROUTER_API_KEY` (or paste one in the admin dashboard) to offer them; the
existing text-gen OpenRouter key is reused automatically.

---

## Verification

Everything below was run against a clean checkout of `8138eab` with the patches
applied, Postgres 16, `pnpm --filter @workspace/db run push`:

| Check | Result |
|---|---|
| `pnpm run typecheck` | clean across all 5 packages |
| `pnpm --filter @workspace/api-server run test` | 2280 / 2281 |
| `pnpm --filter @workspace/socialforge run test` | 838 / 838 |
| `pnpm --filter @workspace/api-spec run lint:spec` | valid |
| `pnpm --filter @workspace/api-spec run codegen` | no drift |
| `git am` onto `8138eab` | clean, all three |

**The one failing test is pre-existing.**
`src/routes/ads.meta-reconnect.test.ts` fails identically on `8138eab` with no
patches applied — it needs a Meta app credential in the environment. It does
not touch video.

New tests added: **92 cases across 7 files** (+1069 lines). Four new suites —
`motionPresets.test.ts`, `aspect.test.ts`, `modelCatalog.test.ts`,
`cinematography.test.ts` — plus extensions to `motionPrompt.test.ts` and
`replicateLipSync.test.ts`, and 27 new cases in `routes/videos.test.ts`
covering the catalog endpoints, validation-before-funding, unit multipliers,
portrait / bring-your-own-audio lip sync, and end-frame gating.

---

## Known limits

- **No plan gating on models.** Deliberate — see Billing above.
- **The studio's admin screen has no allowlist UI yet.** The API is there
  (`enabledModelIds` on `PUT /admin/video-gen-settings`) and the settings
  response now includes the full `modelCatalog` so the card can be built from
  one request. Cloning the pattern in `admin/ai-tab.tsx` is the follow-up.
- **Mobile shows the new controls only where it already showed the old ones.**
  `artifacts/mobile/app/videos.tsx` still submits a plain text-to-video job; it
  typechecks and behaves exactly as before, and the new fields are all
  optional.
- **Continue / extend an existing render is not built.** Seedance 2.0 Extend
  continues a generation by its `request_id`, but neither Replicate nor
  OpenRouter's video API exposes that handle, so there is nothing to build
  against today. It needs a provider that returns and accepts a continuation
  id — at which point it is a new engine branch plus one column
  (`providerRequestId` on `video_generations`).
- **Multi-reference subject consistency and the v2v watermark remover are not
  built.** Both need a specific model whose input schema could not be verified
  without live API access, and guessing a slug costs a paid job. Character lock
  already covers subject consistency for people; the product case is the gap.

---

## API surface (new)

```
GET  /ai/video-models             — models this workspace can pick, with capabilities and unit price
GET  /ai/video-motion-presets     — named camera moves, grouped for a picker
GET  /ai/video-cinematography     — camera bodies, lenses, focal lengths, apertures
```

New request fields on `POST /ai/generate-video`: `modelId`, `resolution`,
`quality`, `generateAudio`, `motionPreset`, `cinematography`, `seed`,
`sourceImagePath`, `audioPath`, plus `4:5 / 4:3 / 3:4 / 21:9` on `aspectRatio`
and an optional second entry in `sourceImagePaths`.

New admin fields on `PUT /admin/video-gen-settings`: `enabledModelIds`,
`lipSyncPortraitModel`. Both are omit-to-leave-unchanged, so an older admin
client cannot wipe them.

New per-scene fields on the storyboard PATCH: `motionPreset`, `seed`.
