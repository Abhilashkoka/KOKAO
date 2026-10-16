# Quick Create — setup

Branch: `feat/quick-create` (built on `feat/prompt-kit-script-variants`).

## What it adds
- **/create** — one-screen Quick Create: optional template, one photo, one sentence,
  length (5/10/15/30s), shape (9:16 / 1:1 / 16:9), language and music, then Generate.
  - With a photo it uses `image_to_video`; without, `text_to_video` (1 shot).
  - The Generate button shows the credit quote (`/credits/quote`) and balance after,
    only when the workspace is on credits. Free plan sees an upgrade note.
  - "Advanced studio" links to the existing Video Studio (unchanged).
- **/results** — your video jobs: player, status, download, "Edit a part"
  (opens the job in the studio, where Smart Edit lives), "Make another".
- Sidebar: **Create** and **Results** added above AI Studio.

No backend, database or env changes. Existing Video Studio and Guided Story are untouched.

## Files
- `artifacts/socialforge/src/pages/quick-create.tsx` (new)
- `artifacts/socialforge/src/pages/results.tsx` (new)
- `artifacts/socialforge/src/lib/quick-create-presets.ts` (+ test) (new)
- `artifacts/socialforge/src/App.tsx` — 2 routes
- `artifacts/socialforge/src/components/layout.tsx` — 2 nav items

## Pull it into Replit (no Agent needed)
Commit or stash any Replit edits first, then in the Shell:

```bash
git fetch origin
git checkout feat/quick-create
pnpm install
```

Restart the Run and open `/create`.

## Not in this step
- Multi-photo outfit reels with beat-synced cuts (needs a backend pipeline).
- Templates from the admin panel (presets live in `quick-create-presets.ts` for now).
- Nav cleanup and the new pastel theme.
