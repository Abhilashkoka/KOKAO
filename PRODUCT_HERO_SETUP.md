# Product hero — Guided Story ads where the product is the star

Patch C1. It applies on top of Patch A (`guided-story-references.patch`) and Patch B (`smart-edit.patch`).

When a product is attached, Guided Story now makes a **product ad**: 60–80% of the video shows the product. That screen time is planned, measured and repaired, and each shot has a type, camera move, lighting and product angle.

## What changed for users

### 1. Promotion level: **Product hero** (the new default)
- Setup → Promote products now offers **Product hero / Featured / Subtle**.
- Product hero adds **Product on screen: 60% / 70% / 80%**. 70% is the default.
- Featured and Subtle behave exactly as before.

### 2. More photos per product (Brand Kit → Products)
- Every product can hold **up to 5 photos**: the main one (front) plus **back, side, top, label close-up, detail, in use, packaging**.
- There is one photo per side; uploading the same side again replaces it.
- These let each shot show the right side of the product instead of the AI inventing it.

### 3. The script is planned as an ad
**What the writer is told:**
- The product is the subject and the story serves it.
- At least the target share of runtime must be product scenes.
- Vary the shots, never repeating a shot type twice in a row.
- Product-only B-roll scenes have no people and narration only; close-ups may show hands without a face.
- The opening may be a product hook, and the video ends on a hero shot with the call to action.

**Shot plan:** every scene gets one.

| Field | Options |
|---|---|
| Shot | macro close-up, hero shot, in hand, in use, texture, product only, character + product, story wide |
| Camera | orbit 360°, push in, pull out, slide, top down, tilt reveal, rack focus, static |
| Lighting | studio key, rim light, backlit glow, window light, light sweep, golden hour |
| Angle | which product photo the shot shows (only angles that have a photo) |

### 4. Screen time is enforced
- After writing, the server measures product seconds ÷ runtime. A product scene is one tagged with the product whose shot is not "story wide".
- **If it is more than 5 points under the target:**
  - One rework pass runs. It keeps every scene's timing, lines and cast, and only re-shoots visuals and shots around the product.
  - The rework is kept only if it raises the share.
- **If it is still low,** the script gets a warning. Approval is never blocked.
- **Script review shows:**
  - a **Product on screen: 72% · target 70%** meter
  - per-scene **Shot / Camera / Lighting / Angle** pickers on product scenes

### 5. Product-first rendering
- **Framing:** a product scene's prompt opens with product-first framing:
  - the product is the subject, the largest and sharpest thing in frame
  - shallow depth of field and a blurred background
  - a legible label
  - then the shot, camera, lighting and angle text
- **Angle photos:** the photo of the chosen angle is sent as the product reference on Wan reference-to-video and as the reference everywhere else. If no angle is chosen, macro and texture shots prefer the label close-up.
- **Product-only scenes (no cast):**
  - They animate the product photo itself on image-to-video providers.
  - On Wan they send the product and backdrop as references.
  - Face-consistency rules are skipped; a "label stays identical" rule replaces them.
- **Byte checks:** every angle photo is pinned by SHA-256 when the story is set up, re-checked at enqueue, and re-checked before each paid scene.

## Apply it

On top of Patches A and B, from the repo root:

```bash
git apply --check product-hero.patch
git am product-hero.patch
pnpm install
pnpm run typecheck
```

- **No database push.**
  - Angles live in `brand_assets.metadata_json.angles`.
  - Hero settings live in the existing draft and job JSON: `products.heroShare` and `scenes[].shot`.
- **Generated clients are included.**

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/brand-kits/:id/products/:assetId/angles` | `{imagePath, view}` → adds or replaces that side's photo. Max 5 photos in total. |
| DELETE | `/api/brand-kits/:id/products/:assetId/angles/:angleId` | Removes an extra photo |

- `productSelection.promotion` accepts `hero`, plus an optional `heroShare` (0.6–0.8).
- Scripts carry `scenes[].shot`.
- Drafts return `productScreenTime {seconds, share, runtime, target}` for hero stories.

## Cost

- **Usually no change.** Product-only shots carry no character references, so they cost the same or less per second.
- **The rework pass is the one exception.** It is one extra text call, only when the first script falls short, and is charged inside the same script-writing operation.

## Tips for the best product ads

- Upload at least a **label close-up** and a **back** or **side** photo. This is the biggest quality win.
- Use **In scene** display mode for hero products. **Exact card** products are overlaid as cards, not filmed.
- Write the topic around the product ("@serum's texture, how fast it absorbs, the glow by morning"), not a plot.
- **Problem → Solution** and **Explainer** genres suit product ads best.

## Tests

- `api-server/src/lib/videoGen/productHero.test.ts`: shot parsing, screen-time measure and warnings, target clamping, the hero brief, the product-only opening, angle-photo choice per shot, and product-first prompts with no face rules on product-only shots.
- `api-server/src/routes/brandProducts.test.ts`: add, replace and remove angles; the 5-photo cap; angles frozen into a hero selection with the share clamped.
- `socialforge/src/components/product-hero.test.tsx`: the screen-time meter and the shot picker showing only available angles.
- Full `videos.test.ts`, all `lib/videoGen` suites and the Guided Story UI suites pass. One real-ffmpeg topic-video music test fails, and it also fails on the untouched base branch.
