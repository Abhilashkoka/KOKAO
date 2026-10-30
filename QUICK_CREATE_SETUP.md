# Quick Create — setup

Branch: `feat/quick-create` (built on `feat/prompt-kit-script-variants`).

## What it adds

### 1. Quick Create + Results
- **/create** — one-screen Quick Create: optional starter, one photo, one sentence,
  length (5/10/15/30s), shape (9:16 / 1:1 / 16:9), language and music, then Generate.
  - With a photo it uses `image_to_video`; without, `text_to_video` (1 shot).
  - The Generate button shows the credit quote (`/credits/quote`) and balance after,
    only when the workspace is on credits. Free plan sees an upgrade note.
  - "Advanced studio" links to the existing Video Studio (unchanged).
- **/results** — video jobs: player, status, download, "Edit a part"
  (opens the job in the studio, where Smart Edit lives), "Make another".

### 2. Navigation
- Sidebar is now **Home, Create, Results, Brand Kits** (+ Video Pricing / Admin for superadmins).
- Everything else (AI Studio, Library, Schedule, Calendar, Campaigns, Accounts, Ads,
  AI Styles, Promoter, Help, Settings, Analytics, Health) sits under **More**,
  which opens by itself when you are on one of those pages.
- Dashboard gets "Start from text" / "Start from photo" tiles that open /create.

### 3. Quick Create starters in Admin
- New **Admin → Quick Create** tab: add, edit, publish, order and delete starters
  (name, business type, prompt, length, shape, photo hint, music).
- "Import built-in starters" copies the 8 built-in starters in as drafts.
- Users see published starters; until one is published they see the built-in list.
- New table `quick_create_presets`; endpoints `GET /api/quick-create/presets` and
  `/api/admin/quick-create-presets` (superadmin only, audited).

### 4. Theme
- Pastel KOKAO theme: lavender-white background, violet primary (#6D42F0),
  softer borders, rounder corners, and pastel tint colours
  (`bg-pastel-lavender | peach | mint | sky | butter`).
- Fonts: **Manrope** for text, **Sora** for headings.
- A brand colour set in App Branding still overrides the primary colour.

## Pull it into Replit (no Agent needed)
Commit or stash any Replit edits first, then in the Shell:

```bash
git fetch origin
git checkout feat/quick-create
pnpm install
psql "$DATABASE_URL" -f lib/db/sql/2026-10-16_quick_create_presets.sql   # adds only the new table
```

Restart the Run. Do the same SQL step for production (safe to run twice).

Do NOT use `pnpm --filter @workspace/db run push` for this: if your database has
columns from work that is not on GitHub yet, push offers to DROP them.

## Checks run
- Typecheck: libs, API server and web app pass.
- Web app tests: 139 files / 1,324 tests pass.
- New API tests (against a real Postgres) pass: admin-only access, publish filter,
  create / edit / delete, and input limits.

## Not in this step
- Multi-photo outfit reels with beat-synced cuts (needs a backend pipeline).

## Showcase Reel (several outfits, one model, cut on the beat)

Create → **Showcase reel**.

1. Optional: add a model photo. Without one, the first dressed look sets the face for the rest.
2. Add 2–6 outfit photos (multi-select works), then **Dress the model in all looks**.
3. Upload a music track. The beat is detected in the browser, and every look is cut to whole bars (1, 2 or 3 bars per look).
4. Pick **Video** (one AI clip per look, joined on the beat) or **Photo** (a gentle photo slideshow; faster and cheaper).

Requirements:
- Dressing a model (single video or reel) no longer depends on the studio's **Reference images** switch.
- No database step. New options are stored in the existing `options` JSON column.
- Video reels cost one clip per look. Photo reels cost the same as a slideshow.

## Drafts survive navigation

Everything on Create is kept in a draft: photos, dressed looks, music, settings, and any request still running. You can leave Create and come back, or refresh the page, and nothing is lost. The draft belongs to one workspace. **Start over** clears it.

## Updating the Replit preview

One command pulls the latest code, rebuilds the web app, restarts the API in the background, and waits until both are healthy. It never touches the database.

```
bash scripts/kokao-update.sh            # pull feat/quick-create-v2 and restart
bash scripts/kokao-update.sh --no-pull  # restart only (e.g. after the workspace slept)
```

The API log is at `/tmp/api.log`.

## Men's wear

- **Model: Woman / Man** appears in single videos (when the photo is put on a model) and in the Showcase reel. It sets the AI model's gender when no model photo is given.
- Reels made with **Man** use men's moves: a confident walk, a slow turn, adjusting the cuff or collar, a hand-in-pocket pose, a namaste, a glance over the shoulder.
- New templates: **Kurta Showcase (Men)**, which opens the reel, plus **Sherwani / Wedding (Men)** and **Formal / Office Wear (Men)**. Admin templates whose name mentions men, groom or sherwani pick Man automatically.

## Ethnic, formal and casual wear

- **Style: Ethnic / Formal / Casual** sits next to Model: Woman / Man.
  - It sets the **backdrop** of each dressed look: a festive studio, a minimal grey studio, or an outdoor lifestyle scene (city street or cafe).
  - In Video reels it also sets the **moves**. Each model and style has its own six moves, for example buttoning a jacket for formal wear or a relaxed walk for casual wear.
- **Garment prints, graphics and logos are kept.** Only text that isn't part of the garment (shop signs, price tags, watermarks) is ignored.
- New template: **Casual Showcase (Men)**. Templates mentioning suit, blazer or office pick Formal; jeans, tee or street pick Casual; saree, kurta or sherwani pick Ethnic.

## Reel cost settings (Admin → Quick Create)

One card controls what a Showcase reel costs. Changes apply to every workspace from the next reel, and each save is listed in **Change history** (from the admin audit log: who, when, from → to).

| Setting | Default | Effect |
|---|---|---|
| Dressing image quality | Medium | gpt-image-2 quality for dressing a model. Medium is about ₹4 per look; High is about ₹16. |
| Reel video resolution | 720p | Resolution of each AI clip in a reel; about half the cost of 1080p. |
| Default bars per look | 1 | Shorter clips (about 2–3 s) cost less to generate. |
| Offer Hero reel | On | One look (★) is an AI video and the rest move as photos. Priced as one clip. |
| Default reel type | Hero | What a new reel opens on. |

Database: `lib/db/sql/2026-10-30_reel_cost_settings.sql` (additive). `scripts/kokao-update.sh` runs it on the development database. For production, run it once in the production database console. Until it is run, reels use the defaults above and saving shows an error.
