# KOKAO Video Studio — integration guide

A full-stack video generation feature, built to match your existing patterns (contract-first API, imageGen-style provider registry, quota→credit funding, kill switches, tenant scoping).

## What you got

**Three engines**, all landing in workspace storage and the content library:

1. **Text to Video** — prompt → AI clip (Replicate, default `wan-video/wan-2.2-t2v-fast`; admins can switch to Veo 3, Kling, MiniMax, or any Replicate model).
2. **Animate Photo** — one photo + optional motion hint → AI clip (`wan-2.2-i2v-fast` default).
3. **Photo Slideshow** — photos → MP4 with crossfades, optional burned-in caption and background music. Pure ffmpeg, no AI cost.

**Photo sources**: direct upload, your content library, or **Google Drive** (read-only OAuth, folder browser, per-photo import into workspace storage).

**Where videos land**: every finished video gets a poster thumbnail and can be saved to the Content Library as a draft reel (`videoPath` + `videoThumbnailPath` on content items; the library grid now renders a video player). Scheduling works as usual. *Note: the publishing cores are still image-only — publishing a video item to a platform (IG Reels etc.) is the natural next step.*

**Billing**: new `video` quota + credit kind, wired end-to-end — plan limits (free 3/mo, pro 50/mo, business unlimited, payg credits-only), credit packs (`videoCredits`), purchases, Razorpay webhook backstop, atomic reserve/refund, usage metering.

**Controls**: `videoGen` kill switch (admin dashboard), superadmin provider/model/key management at `/admin/video-gen-settings` (keys AES-encrypted in `app_credentials`, env fallback `REPLICATE_API_TOKEN`).

## Apply it

In the Replit shell, from the repo root:

```bash
git apply --check video-studio.patch   # dry run — should print nothing
git am video-studio.patch              # applies as one commit
```

(If `git am` complains, `git apply video-studio.patch` then commit normally.)

Then:

```bash
pnpm --filter @workspace/db run push   # new tables + columns (additive, no data loss)
```

No new npm dependencies. Generated API clients are included in the patch (drift check passes).

## Configuration

1. **Replicate** (AI engines): set the `REPLICATE_API_TOKEN` secret, or paste a key in Admin → video gen settings. Slideshow works with zero config.
2. **Google Drive** (optional): reuses your existing Google OAuth client (the YouTube one / `GOOGLE_CLIENT_ID`+`SECRET`). Two one-time steps in Google Cloud Console:
   - add authorized redirect URI: `https://<your-domain>/api/google-drive/auth/callback`
   - ensure the `https://www.googleapis.com/auth/drive.readonly` scope is allowed on the consent screen
3. **ffmpeg**: already present in the Replit image (your audio pipeline uses it). Nothing to do.

## Verified

- `pnpm run typecheck` — clean across all packages (api-server, web, mobile)
- API server: **1024/1024 tests pass** (includes 14 new: real-ffmpeg slideshow encodes, route funding/tenancy/validation)
- Web: **302/302 tests pass** (5 new for the Video Studio page); mobile 149/149
- Spec lint + codegen drift check — clean
- `db push` applied cleanly against a fresh Postgres 16

## API surface (new)

`POST /ai/generate-video` → job; `GET /ai/video-jobs[/{id}]` → poll; `POST /ai/video-jobs/{id}/save-to-library`. Google Drive: `/google-drive/{status,auth/url,files,import}`, `DELETE /google-drive`. Admin: `/admin/video-gen-settings`, `/admin/video-gen-providers/{id}/key`.

## Known limits (v1)

- Video publishing to social platforms not yet wired (drafts + scheduling only).
- Admin UI has the API for provider switching but no dedicated card yet — settings changes work via the endpoints; cloning the image-gen card in `admin/ai-tab.tsx` is a quick follow-up.
- Admin manual credit grants and promo codes cover caption/image credits only; video credits flow through credit packs.
- AI video jobs run in-process (same as your publishing jobs); a server restart mid-job marks it failed and refunds the credit.
