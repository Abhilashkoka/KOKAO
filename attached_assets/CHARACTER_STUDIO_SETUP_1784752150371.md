# KOKAO Character Studio — integration guide

Character lock, costume lock, and costume changes for your Video Studio. Applies **on top of the Topic to Video patch** (`topic-video.patch` must be applied first).

## How identity locking works

Prompting alone can't keep a character consistent — video models drift. This patch uses the only approach that reliably works today: **reference anchoring**.

1. **Character** — a saved identity with a canonical full-body reference image. Describe them ("a cheerful woman in her late 20s, shoulder-length black hair…") and AI generates the reference, or upload a photo. Stored per tenant, managed from the new **Characters** dialog in the Video Studio.
2. **Outfits (costume lock)** — every costume is an identity-preserving `gpt-image-1` edit of the *same* reference: same face, same pose, new clothes. Each character starts with a Default outfit; add as many as you like ("Gym wear: black leggings, teal top"). Locking an outfit pins the wardrobe for a whole video.
3. **Costume change** — in character story videos, type wardrobe notes ("switch to gym wear for the workout scenes") and the scene planner assigns outfits per scene — locked default everywhere else, changes only where the story calls for them.
4. **Scene anchoring** — every generated scene starts from a keyframe: an image edit that places your character (in that scene's outfit) into the scene described by the script. The keyframe is then animated by your existing image-to-video engine (WAN i2v / Kling / MiniMax via Replicate). The character in frame one is *your* character, not the model's guess.

Honest caveat: identity stays strongly consistent, not pixel-perfect — that's the state of the art everywhere right now. Photorealistic characters anchor better than stylized ones.

## Where it appears

- **Text to Video** — a "Character (optional)" picker. With a character picked, your prompt becomes an identity-anchored keyframe that gets animated. Still 1 video unit.
- **Topic to Video** — a new **Visuals** toggle: *Stock footage* (unchanged) or *Your character*. Character mode generates every scene with the locked character: script → narration → scene plan (visual + outfit per scene) → concurrent keyframe+animate per scene → composed with subtitles and music as before.

## Billing (the suggestion you asked for)

Character story videos cost **one video unit per scene** — every scene is a real keyframe + image-to-video generation on your Replicate account, so flat pricing would lose you money on long videos:

| Length | Scenes | Video units |
|--------|--------|-------------|
| Short (~30s) | 4 | 4 |
| Medium (~60s) | 8 | 8 |
| Long (~90s) | 12 | 12 |

Units are reserved up front (quota first, then credits, all-or-nothing), refunded in full if the job fails, and the UI shows the cost before generating. Character references and outfit variants fund exactly like image generations (image quota/credits). Single clips stay 1 unit.

## Apply it

In the Replit shell, from the repo root (after `topic-video.patch`):

```bash
git apply --check character-studio.patch   # dry run — should print nothing
git am character-studio.patch              # applies as one commit
```

Then create the two new tables (additive, no data loss):

```bash
pnpm --filter @workspace/db run push
```

No new npm dependencies. Generated API clients included (drift check passes).

## Configuration

Nothing new. It reuses your existing pieces: the OpenAI integration (references, costumes, keyframes — `gpt-image-1`), your Replicate key (scene animation via the Video Studio's i2v provider), and your text model (script + scene planning). Characters share the `videoGen` kill switch.

## Verified

- `pnpm run typecheck` — clean across all packages
- API server: **1072/1072 tests pass** (26 new: character CRUD funding/tenancy/refunds, per-scene unit billing incl. all-or-nothing 402s, scene grouping, wardrobe planning with fallback, identity-anchored scene generation, scene-mapped real-ffmpeg composition)
- Web: **306/306** (2 new); mobile 149/149
- Spec lint + codegen drift check — clean
- `db push` — applies `characters` + `character_outfits` cleanly

## API surface (new/changed)

- `GET/POST /characters`, `DELETE /characters/{id}`, `POST /characters/{id}/outfits`, `DELETE /characters/{id}/outfits/{outfitId}` (default outfit protected)
- `POST /ai/generate-video` — new optional fields: `visualsSource` (`stock|character`, topic only), `characterId`, `outfitId` (server resolves the default), `wardrobeNotes`
- Character/outfit validation happens before funding; cross-tenant references 400.

## Known limits (v1)

- A Medium character video ≈ 8 image edits + 8 i2v generations — expect **5–15 minutes** (scenes run 3 at a time; 25-minute job deadline). The UI says so while it runs.
- Consistency is strong but not perfect across scenes; faces hold up best with photorealistic characters and detailed appearance descriptions.
- Outfit changes are planned by the model from your wardrobe notes — there's no manual per-scene outfit grid yet (natural v2 if you want tighter control).
- Character images use gpt-image-1's portrait size (1024×1536); keyframes match your video's aspect via the closest supported size, and the compositor cover-crops.
- No character edit/rename endpoint yet — delete and recreate (v2 candidate).
