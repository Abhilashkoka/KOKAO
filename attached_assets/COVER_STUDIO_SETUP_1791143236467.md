# KOKAO Cover Studio: setup guide

This patch adds the editorial look from the @zeeeljain grid review to KOKAO's image and video studios:

- magazine-cover typography;
- the headline set behind the subject's head;
- one muted, filmic colour grade shared by images and reels;
- an "Editorial cover" photo preset that composes portraits with space for the headline.

## What you get

**1. Cover Studio (AI Studio → generated image → "Make cover")**

- Crops to **1080×1350 (4:5)** around the person, keeping all type inside the area the 3:4 profile grid shows.
- **Three-tier type system:**
  - a *kicker* in Instrument Serif Italic ("My", "The art of");
  - a hero *headline* in Anton bold caps or Inter Tight;
  - a quiet *subline*.
- The type is auto-fitted, so the hero word always fills the frame.
- **Headline behind the person:** the subject is cut out and stacked over the headline. If the person would hide more than 40% of the word, the cover switches to text-over and says why.
- **Auto type colour:**
  - white or ink is picked from the photo;
  - a soft edge gradient is added only when white type needs help to stay readable.
- **Accents:** ✦ sparkle, hand-drawn arrow, or none.
- **"Write it for me":** the brief becomes kicker, headline and subline in the brand voice. The writer never names public figures, film or TV characters, or other brands. For clinics it avoids cure claims, prices and before/after promises.
- **Re-editable:** the result opens in the existing layer editor, with headline, subject, kicker, subline and accent each as a separate movable layer.

**2. Editorial grade (images and video)**

- Saturation is pulled to about 80%, blacks are lifted, skin gets a slight warm bias, and fine film grain is added. This removes the plastic AI look and makes separately generated posts read as one grid.
- Images get the grade inside Cover Studio.
- Every AI video clip gets the same grade during normalisation, with no extra encode.

**3. "Editorial cover" Look preset (AI Studio → Look):**

- 85mm at f/1.4 with window light.
- Waist-up, centred framing with the head in the upper-middle.
- A real location (library, office, café).
- Negative direction against plastic skin, HDR and oversaturation.

Use this preset to generate the photo, then press "Make cover".

## Apply it

In the Replit shell, from the repo root:

```bash
git apply --check cover-studio.patch   # dry run — should print nothing
git am cover-studio.patch              # applies as one commit
```

(If `git am` complains, run `git apply cover-studio.patch` and then commit normally.)

There is **no database migration** and there are **no new npm dependencies**. The fonts ship in `artifacts/api-server/assets/fonts` (SIL OFL, licences included), and the generated API clients are included.

## Configuration

- **Subject cut-out (for "headline behind"):**
  - Uses the Replicate key the Video Studio already has (Admin → video gen settings, or `REPLICATE_API_TOKEN`).
  - The default model is `851-labs/background-remover`. Override it with the `COVER_MATTE_MODEL` secret (any Replicate `owner/name` that takes `image` and returns a transparent PNG).
  - Without Replicate, it falls back to the built-in OpenAI cutout. That is slower and costs a full image generation.
  - If both fail, the cover is built text-over and the user is not charged.
- **Fonts:** found automatically. Set `COVER_FONTS_DIR` only if you deploy the server bundle away from the repo.
- **Kill switches** (Admin → Feature Controls; both default on):
  - **Cover Studio** (`coverStudio`)
  - **Editorial Video Grade** (`editorialVideoGrade`). Turn this off to keep raw provider colour on video.

## Billing

| Action | Charge |
|---|---|
| First cover with "headline behind the person" | 1 image (wallet/quota/credit), billed only if the cut-out succeeds |
| Text-over cover | Free |
| Changing words, colour, style or accent after the first cover | Free (re-uses the stored canvas and cut-out) |
| "Write it for me" | Free |

## API surface (new)

- `POST /ai/cover`: build a cover. It takes either `imagePath`, or `reuse: {basePath, subjectPath}` from a previous result, plus `copy` and the style options. It returns the flat PNG, a layer document, `basePath`/`subjectPath`, the `layout` actually used, a `notice` and `units`.
- `POST /ai/cover-copy`: `{topic, brandKitId?}` → `{kicker, headline, subline, source}`.
- The `ImagePromptRecipe.preset` enum gains `editorial`.

## Verified

- `pnpm run typecheck`: clean across libs, api-server, web, mobile, promo and sandbox.
- Spec lint and codegen are clean.
- New tests:
  - `lib/cover/compose.test.ts`: crop placement, layer order, auto colour, occlusion and no-matte fallbacks, bounds, grade, copy splitter, options, provider padding.
  - `lib/cover/matte.test.ts`: Replicate version resolution, alpha rescaling, OpenAI fallback, never-throw.
  - `routes/ai.cover.test.ts`: billing on and off, free re-typeset, validation before charge, copy route with fallback.
  - `cover-studio-dialog.test.tsx`: auto-draft, paid then free re-typeset, apply, notice.
- The existing `postprocess` (video normalise) and Studio page tests pass unchanged.

## Known limits (v1)

- The covers are built in Studio's single-image view. Carousel slides and campaign cards can use them through the editor afterwards, but they have no "Make cover" button yet.
- Reel covers: generate the cover from a still and set it as the reel's cover image when you post. Automatic first-frame covers are a natural next step.
- Cover type is rasterised per layer, so it can be moved and resized in the editor. To change the words, re-open Cover Studio (re-typesetting is free).
