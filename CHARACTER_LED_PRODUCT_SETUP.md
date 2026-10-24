# Character-led product ads (40–50%) and the product nudge

Branch `feat/guided-comedy-product-share`, on top of `feat/quick-create-v2`.

Lets Guided Story make comedy and story product ads with the user's own characters, where the product is on screen 40–50% of the video instead of 60–80%.

## What changed for users

### 1. Product on screen: 40% / 50% / 60% / 70% / 80%
- Setup → Promote products → **Product hero** now offers 40% and 50%. 70% stays the default.
- At 40–50% a hint shows: *Character-led: your characters stay on screen using and reacting to the product.*

### 2. Character-led brief (below 60%)
**The script writer is told:**
- The story and genre tone stay intact; the product is the turning point.
- Product scenes keep the characters on screen: `character_with_product`, `in_hand`, `in_use`, with the speakers in `roleIds`.
- At most one product-only, macro or texture beat (a reveal or the final hero shot).
- Leave room for setup and reaction beats.

**The screen-time rework** (runs once if the share is more than 5 points short) turns context scenes into character-and-product shots. It never turns dialogue scenes into product-only shots.

At 60–80% nothing changes.

### 3. "Looks like a product ad" nudge
- Appears under the topic when it reads like a product ad, and no Brand Kit product is selected and no upload is tagged as a product.
- **Attach product** scrolls to the Brand Kit product picker. **Not a product ad** hides it for this story.
- It never blocks. Generic topics don't trigger it.

## Recommended setup for a comedy product ad
Genre **Comedy** (or Satire/Parody) → Brand Kit → pick the product → **Product hero** → **40% or 50%** → saved characters.

## Apply it

Pull the branch, then from the repo root:

```bash
pnpm install
pnpm run typecheck
```

- **No database push.** `heroShare` already lives in the draft and job JSON.
- **Generated clients are included** (`heroShare` minimum is now 0.4 in the OpenAPI spec).

## Files

| Area | File |
|---|---|
| Floor, character-led brief, rework text | `artifacts/api-server/src/lib/videoGen/productHero.ts` |
| Rework uses the shared instruction | `artifacts/api-server/src/lib/videoGen/guidedStory.ts` |
| API minimum 0.4 | `lib/api-spec/openapi.yaml` + regenerated zod and React client |
| 40/50% options and hint | `artifacts/socialforge/src/components/brand-products.tsx` |
| Nudge logic | `artifacts/socialforge/src/lib/product-nudge.ts` |
| Nudge UI | `artifacts/socialforge/src/components/guided-story-workflow.tsx` |

## Tests
- `productHero.test.ts`: the 40–80% clamp, character-led rules and rework text.
- `product-nudge.test.ts`: product-ad detection and when the nudge shows.
