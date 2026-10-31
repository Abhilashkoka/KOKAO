# Ad skills: Jewellery & Accessories

Branch `feat/jewellery-product-ad`, built on top of `feat/shop-promo-overlays`.

Ad skills are category presets that sit on top of **Product hero**. A skill changes how the ad is written and filmed for one kind of product, while the Product hero engine stays the same. Jewellery & Accessories is the first skill.

## What the user sees

**Guided Story → Setup → Promote products → Product hero**, then a new row:

| Setting | Options |
|---|---|
| **Ad skill** | General product / 💎 Jewellery & Accessories |
| **Look** (jewellery) | Bridal / Festive / Everyday luxe / Minimal |
| **Who wears it** (jewellery) | Your characters / Hands & neck only / No model |

- Picking Jewellery moves **Product on screen** to **80%**. The user can still change it.
- A tip asks for a **detail** close-up and an **in use** (worn) photo in Brand Kit → Products.
- The skill only applies to Product hero. Featured and Subtle never show the selector.

## What changes in the video

**Script brief:**
- Luxury jewellery commercial: slow pacing with 3–5 second shots and no jump cuts.
- Minimal words.
- Shots: macro on stones, 360° turns, light sweeps, rack focus, on-body shots, a box reveal.

**Look:** sets the backdrop, light and styling. For example, Bridal brings red and gold silk, diya glow and mehendi hands.

**Who wears it:**
- **Your characters:** the cast wears the piece in at least two scenes.
- **Hands & neck only:** faceless body crops. Product scenes drop the cast, and their dialogue becomes narration.
- **No model:** no people or hands in any scene. Pieces appear on a bust, tray, box or pedestal, with narration only.

**Scene prompts:**
- Sparkle and specular cinematography plus a per-shot jewellery detail.
- The "label legible" rule is dropped, since jewellery has no label.
- Macro and texture shots use the **detail** photo instead of the label photo.

**Fidelity rule:** the last line of each scene prompt locks the metal colour, motif, stone count, stone colours, setting and proportions.

## Apply

- **No database change.** The skill is stored in the existing draft JSON as `products.adSkill`.
- **Generated clients are included.**

On the server, from the repo root:

```bash
git fetch origin && git checkout feat/jewellery-product-ad
pnpm install
pnpm run typecheck
```

Or merge the branch into your working branch, then run `scripts/kokao-update.sh`.

## API

`productSelection.adSkill` takes `{ id: "jewellery", look?: "bridal"|"festive"|"everyday"|"minimal", model?: "cast"|"body_only"|"none" }`.

- It is used with `promotion: "hero"` only.
- `null` or omitted gives a general product ad.
- An omitted `look` defaults to `everyday`, and an omitted `model` defaults to `cast`.
- When `heroShare` is omitted, the skill's default applies (0.8 for jewellery).

## Adding the next category (watches, bags, sunglasses…)

1. Add the id to `GuidedStoryAdSkill["id"]` in `lib/db/src/schema/guidedStories.ts` and to the enum in `openapi.yaml`, then run `pnpm --filter @workspace/api-spec run codegen`.
2. Add a `SKILLS` entry in `artifacts/api-server/src/lib/videoGen/productSkills.ts` with its rules, shot clause, fidelity line and default share.
3. Add the option to the **Ad skill** row in `GuidedProductPicker` (`brand-products.tsx`).

## Tests

- `api-server/src/lib/videoGen/productSkills.test.ts` covers:
  - normalising the skill and its defaults, and that it only applies to hero stories
  - the 80% default
  - the jewellery script brief
  - detail photos chosen for macro shots
  - no label rule, plus the look and people rules in the prompt
  - the fidelity line
  - cast and dialogue stripping for Hands & neck only and No model
- `socialforge/src/components/brand-products.test.tsx` covers:
  - the selector appearing only on Product hero
  - the 80% bump
  - the look and model buttons
  - the payload round trip
- All `lib/videoGen` suites, `brandProducts`, `videos.test.ts` and the Guided Story UI suites pass, with two exceptions:
  - The real-ffmpeg music timing test also fails on the base branch.
  - One locked-cast test is flaky under full-suite load and passes when run alone.
