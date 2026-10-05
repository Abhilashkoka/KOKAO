# Guided Story — Products & Services references

Upload product or service photos to a Brand Kit once. Guided Story then uses them when it writes the script and renders the scenes, so stories can promote what the brand sells.

## What you got

**Brand Kit → Products tab** (new 5th tab in the Edit Brand dialog)
- Upload a photo (PNG/JPEG/WebP, ≤10 MB) with a name, a type (Product / Service) and a one-line "what it is + benefit".
- **AI look:** right after upload, a vision model describes the photo once: shape, colours, packaging and the exact label text. The description is saved and reused. If it fails, the upload is still kept; use **Retry AI look**.
- **How it appears:**
  - *In scene*: the AI places the product in the shot.
  - *Exact card*: your untouched photo is overlaid as a card in the upper-right of that scene. Use this when the label must stay readable.
- Up to 24 items per brand. Saved instantly; no "Save brand" needed.

**Guided Story setup**
- After you pick a Brand Kit, a **Promote products or services** picker shows its catalogue. Pick up to 4.
- **Featured / Subtle** switch:
  - *Featured* (default): one hero moment for the product, plus a short call to action in the last scene.
  - *Subtle*: the product appears naturally in 1–2 scenes, with no pitch.
- Each selection is frozen into the draft with a SHA-256 hash of the image. Later Brand Kit edits don't change a story that's already in progress. Switching Brand Kit clears the selection.

**Script writing**
- The writer gets each product's name, your notes and the AI look, all marked as data, not instructions. It also gets the Featured or Subtle rules.
- It must not invent prices, guarantees, cure claims, statistics or testimonials. Your existing NMC/ICAI compliance hints still apply.
- Each scene returns `productIds` (max 2 per scene).
- If Featured is on and no scene shows a product, the script gets a warning. It does not block approval.

**Script review**
- Every scene has **Shows:** chips with product thumbnails. Toggle which products appear in that scene before you approve.

**Rendering**
- **Atlas Wan 3.0 reference-to-video:** in-scene product photos are attached as real reference images after each cast member's character sheet and outfit images. The approved backdrop plate is also attached so the `@ImageN` labels in the prompt line up. The prompt then says to show the product "exactly as in @ImageN".
- **Seedance (asset library) and plain image-to-video models:** these can't take product photos, so the product is described in the prompt using its saved AI look.
- **Legacy storyboard-preview jobs:** product photos are added as labelled image references.
- **Exact-card products:** composited onto the finished scene clip with ffmpeg. They fade in, are placed below the platform's top bar, and stay clear of the lower-third logo and captions.
- **Hash checks:** every product image is checked against its hash when the job is enqueued and again before each paid scene. If an image changed, the job stops with a clear message *before* money is spent.

## Apply it

On top of `feat/prompt-kit-script-variants` (commit `6a74eac`), from the repo root:

```bash
git apply --check guided-story-products.patch   # dry run — should print nothing
git am guided-story-products.patch              # applies as one commit
```

**No database push needed.** Products are `brand_assets` rows with `asset_type = 'product'` and their fields in `metadata_json`. Guided selections live in the existing `guided_story_drafts.state` / `video_generations.options` jsonb.

**No new dependencies.** The regenerated API clients (`lib/api-zod`, `lib/api-client-react`) are included in the patch.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/brand-kits/:id/products` | List products & services |
| POST | `/api/brand-kits/:id/products` | `{imagePath, name, kind?, description, displayMode?}` → stores and describes the photo |
| PATCH | `/api/brand-kits/:id/products/:assetId` | Edit name / kind / description / displayMode |
| POST | `/api/brand-kits/:id/products/:assetId/describe` | Retry the AI look |
| DELETE | `/api/brand-kits/:id/assets/:assetId` | Remove (the existing asset route) |

Guided setup input gets an optional `productSelection: {promotion: "subtle" | "featured", assetIds: number[]}`.
- Leave it out on an update to keep the current selection.
- Send `[]` to clear it.

The draft returns `setup.products`, and scenes carry `productIds`.

## Cost

- **The AI look** is one vision call per upload, usually a fraction of a rupee. It is recorded in AI cost tracking with shadow funding, so it is **not** charged to the user's balance. To charge it, change the `funding` block in `lib/brandKit/products.ts`.
- **Video and script prices** are unchanged. Product references don't add provider calls; exact cards are rendered locally with ffmpeg.

## Known limits

- **Plain image-to-video models** get products in text only, because their single input image is already the approved character outfit. Wan 3.0 reference-to-video gives the best product fidelity.
- **Lip-sync and dialogue-replay scenes** use their own compositor and don't get the exact-card overlay yet.
- **AI-redrawn labels** can still drift on in-scene products. Use **Exact card** for anything regulatory or text-heavy.

## Tests

- `api-server`:
  - `src/lib/videoGen/guidedProducts.test.ts`: script contract, storyboard fingerprints, Wan `@Image` labels, Seedance text fallback
  - `src/lib/brandKit/products.test.ts`: input rules, vision prompt, card render
  - `src/routes/brandProducts.test.ts`: routes, tenant isolation, selection freeze, image-change detection
- `socialforge`: `src/components/brand-products.test.tsx` (picker cap, promotion switch, scene chips)
- The existing Guided Story, clip storyboard and Brand Kit suites are unchanged.
