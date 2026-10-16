# Product consistency — fixing the "necklace" video

Patch D. It applies on top of your live branch `feat/prompt-kit-script-variants` (7570b50), which already contains Patches A, B and C1.

It fixes what went wrong in `KOKAO-127790-exact-necklace-cutaways.mp4`:

| What happened | Cause | Fix |
|---|---|---|
| The 5-panel collage appeared as a frame | The collage was the product's main photo, and product-only shots animate the main photo | Collages are split into single views; a collage is never used as a frame |
| The necklace looked different in every scene | The native-audio prompt had no product text, and Atlas requests had no product photo | `[PRODUCT]` block plus product photos and sheets attached as labelled references |
| The ARDIA name got garbled | "No logos / no on-screen text" fought the product's own printing | "No logos or text except the printing that is really on the product" |
| The necklace vanished after it was put on | "Garment identical to references" restored the outfit without it | Worn products stay worn in every later scene |
| Odd hands fastening the clasp | Video AI can't do self-fastening, and a stray hand entered the frame | Never show putting it on; "no other hands enter the frame" |
| Noisy prompt text | Telugu synopsis, meta instructions, "…" cut-offs and a contradictory wardrobe line | Cleaned up |

## What changed for users

### 1. Collage / reference-sheet uploads (Brand Kit → Products)
- **Automatic, same cost.** One upload still costs one AI photo description.
  - The layout is detected locally for free (divider lines or narrow gutters).
  - The same single vision call describes the product **and** labels each view.
- **The result:**
  - **Main photo:** the clearest single view of the whole product (front by default, never a close-up).
  - **Angles:** up to 4 other panels (side, close-up, back…), one per view.
  - **Reference sheet:** the original collage, kept as a design reference only.
- **Review panel on the product card:**
  - "Your photo was a collage, so we split it into N views."
  - Each view has a label picker (fix the AI's guess) and a **Make main** button.
- **If splitting fails**, the card says the photo is a collage and offers three options:
  - **Upload single view**
  - **Generate clean front shot**: one image edit; you preview it, then press **Use this**.
  - Use one of the existing angles.
- **Story setup:** collage products show "Collage photo · pick a main photo in Brand Kit".

### 2. Rendering
- **Native-audio / Seedance prompts** now include a `[PRODUCT]` block:
  - product-first framing (hero stories)
  - the product description
  - the reference labels
  - the worn state
  - "same single object from first frame to last"
- **Atlas Wan reference-to-video** attaches references in this order: cast pairs → backdrop → for each product, its single-view photo then its multi-view sheet → upload images. Prompt labels follow the same order.
- **Sheet label wording:**
  - On Wan: "@ImageN is a multi-view design sheet … never show the sheet, its panels or a collage on screen".
  - In keyframes: "BRAND PRODUCT DESIGN SHEET … design reference only".
- **Product-only shots** start from a single-view photo, or from the backdrop if none exists. They never start from the collage.

### 3. Wearables (jewellery, watches, glasses, clothing, bags)
- Scenes carry `worn: [productId]`.
- **Script rules:**
  - Never show putting on, fastening, clasping, buttoning, tying or removing.
  - Cut from holding the product to already wearing it.
  - One clear action per scene.
- **Carry-forward:** once a role wears a product, every later scene with that role keeps it tagged and worn, automatically.
- **Prompts:** say "already being worn … stays clearly visible". The consistency line adds "the worn X is part of the look even though the outfit reference does not show it."

### 4. Prompt clean-up
- **Cast scenes:** "No other hands, arms or people enter the frame."
- **Catalogue text** is trimmed at a sentence boundary, never with a trailing "…".
- **Backdrop direction** drops:
  - "Create the primary shared location for the Guided Story …"
  - non-Latin synopsis sentences
  - scene dumps

  It is then capped at about 300 characters.
- **Default wardrobe** for generated cast now reads "the outfit described for this role (…)" instead of an instruction.
- **The script writer is told** never to ask for logos, wordmarks, animated logos or on-screen text. The brand end card is composited.

## Apply it

From the repo root, on `feat/prompt-kit-script-variants`:

```bash
git apply --check product-consistency.patch
git am product-consistency.patch
pnpm install
pnpm run typecheck
```

- **No database push.** New fields live in existing JSON columns:
  - `brand_assets.metadata_json.referenceSheet` and `sheetStatus`
  - `products.items[].referenceSheet` and `scenes[].worn` in drafts and jobs
- **Generated clients are included.**
- **Existing products** stay as they are, with no `sheetStatus`. To split an old collage, delete the product and upload it again.

## API

| Method | Path | Purpose |
|---|---|---|
| PATCH | `/api/brand-kits/:id/products/:assetId/angles/:angleId` | `{view}`: relabel a view. Returns 400 if another photo already has that view. |
| POST | `/api/brand-kits/:id/products/:assetId/main` | `{angleId, previousView?}` swaps in an angle; `{imagePath}` uses a new single-view photo. The sheet itself is refused. |
| POST | `/api/brand-kits/:id/products/:assetId/clean-front` | Makes one image edit from the sheet and returns `{imagePath}` as a preview. Confirm it with `/main`. |

- `BrandProduct` adds `referenceSheetPath` and `sheetStatus` (`single` / `split` / `needs_main`).
- `GuidedStoryProductReference` adds `referenceSheet`. Its bytes are hash-pinned at setup and re-checked at enqueue and before each paid scene.
- `GuidedStoryScene` adds `worn`.

## Cost

- **Collage detection:** free (local).
- **Description + view labels:** one `ai_photo_description` call, the same as before.
- **Clean front shot:** one `image_edit`, only when you press the button.
- **Rendering:** no change in billed seconds. Wan requests carry one or two more reference images per product scene.

## Tips

- Single-view photos still give the best results. A collage is fine; just check the labels after upload.
- For jewellery, write the story as "holds it → (cut) → wearing it". Never write "puts it on".
- Use **In scene** display mode for wearables.

## Tests

- `lib/brandKit/productSheet.test.ts`:
  - splits a divider-line grid
  - leaves a plain photo whole
  - splits **your real necklace collage** (fixture) into 5 panels
  - parses the vision reply, maps loose view names, never picks a close-up as main
- `routes/brandProducts.test.ts`:
  - one paid call splits a collage
  - storage failure → `needs_main`
  - relabel and main-swap, refusing the sheet
  - clean-front preview → accept
  - sheet frozen and hash-checked
- `lib/videoGen/productConsistency.test.ts`:
  - photo + sheet labels
  - single view instead of sheet
  - sentence trimming and backdrop sanitising
  - no stray hands
  - the `[PRODUCT]` block and exclusions in the Seedance prompt
  - worn carry-forward and parsing
- `socialforge/src/components/product-sheet.test.tsx`: split review, make main, clean-front preview → use.
- **Suites run:**
  - `lib/videoGen`, `lib/brandKit`, `brandProducts` and `videos.test.ts`
  - all 139 socialforge test files
  - full typecheck: passes

  One real-ffmpeg topic-video music test fails; it fails on the untouched base branch too.
