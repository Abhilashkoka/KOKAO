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
