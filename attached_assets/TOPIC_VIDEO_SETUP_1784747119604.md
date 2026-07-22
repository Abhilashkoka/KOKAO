# KOKAO Topic to Video — integration guide

A fourth Video Studio engine, ported from MoneyPrinterTurbo (MIT) and rebuilt natively on your stack: give a topic → AI writes the script → stock footage is fetched to match → TTS narrates it → subtitles are burned in → one finished MP4 lands in your workspace, ready for the Content Library.

## What you got

**The engine** (`topic_to_video`), sitting beside your three existing ones:

1. One LLM call (through your textGen routing layer, honoring each tenant's model and the OpenRouter switch) returns the narration script **and** ordered English stock-search terms as JSON.
2. The script is split into sentence-sized chunks; each is spoken via your OpenAI audio integration (`gpt-audio`, six voices). WAV headers give exact per-sentence timings — frame-accurate subtitles with zero transcription cost.
3. Stock clips come from **Pexels** or **Pixabay** (auto = first configured), interleaved across search terms so footage follows the script's visual order. Renditions are picked to just cover the frame; failures on one term never sink the job.
4. ffmpeg (the same binary your slideshow engine spawns) cover-crops each scene, cuts per sentence, burns wrapped white-on-stroke subtitles, and mixes narration (1.0) over optional background music (0.2, faded out) — MoneyPrinterTurbo's proven defaults.

**Controls in the studio tab**: topic, length (Short ~30s / Medium ~60s / Long ~90s), voice (Alloy, Nova, Shimmer, Echo, Onyx, Fable), aspect ratio, subtitles on/off, optional music track (upload, same 15 MB cap as slideshow).

**Everything else reuses your machinery unchanged**: video quota + credit funding (free 3/mo, pro 50/mo, business unlimited, payg credits), atomic reserve/refund, `videoGen` kill switch, tenant-scoped inputs, poster thumbnails, save-to-library as a draft reel, job polling.

## Apply it

In the Replit shell, from the repo root:

```bash
git apply --check topic-video.patch   # dry run — should print nothing
git am topic-video.patch              # applies as one commit
```

(If `git am` complains, `git apply topic-video.patch` then commit normally.)

No `db push` needed — the new job options live in the existing `options` jsonb column. No new npm dependencies. Generated API clients are included (drift check passes).

## Configuration

1. **Stock footage** (required for this engine): get a free API key from [pexels.com/api](https://www.pexels.com/api/) and/or [pixabay.com/api/docs](https://pixabay.com/api/docs/). Set the `PEXELS_API_KEY` / `PIXABAY_API_KEY` secret, or save a key via the admin endpoints (`PUT /admin/stock-sources/pexels/key`, AES-encrypted in `app_credentials`). The settings view (`GET /admin/video-gen-settings`) now reports `stockSources` with configured/keySource per source.
2. **TTS**: nothing to do — uses your existing OpenAI AI integration.
3. **ffmpeg + fonts**: already present in the Replit image. Subtitles use the same font discovery as slideshow captions (DejaVu/Liberation/Noto candidates). Non-Latin scripts (e.g. Hindi) need a font covering that script installed — otherwise add one to the image or toggle subtitles off for those videos.

## Verified

- `pnpm run typecheck` — clean across all packages (api-server, web, mobile)
- API server: **1046/1046 tests pass** (22 new: real-ffmpeg scene composition + subtitle burns, sentence splitting incl. Devanagari, WAV parse/stitch round-trips, narration cue timing, Pexels selection logic, route funding/tenancy/validation for the new engine)
- Web: **304/304** (2 new for the Topic to Video tab); mobile 149/149
- Spec lint + codegen drift check — clean
- Fresh `db push` against Postgres 16 — clean (no schema change required)

## API surface (new/changed)

- `POST /ai/generate-video` — `engine` now accepts `topic_to_video`; new optional fields `voice`, `stockSource` (`auto|pexels|pixabay`), `subtitles`, `paragraphCount` (1-3); `musicPath` now applies to topic videos too. Same funding + 402 semantics.
- `GET /admin/video-gen-settings` — response includes `stockSources`.
- `PUT` / `DELETE /admin/stock-sources/{sourceId}/key` — superadmin key management, mirroring the video-gen provider key endpoints (audited).

## Known limits (v1)

- Generation takes ~1–3 minutes for a 30s video (LLM + per-sentence TTS + downloads + encode); the job has a 10-minute deadline and the UI says so while it runs.
- Stock source is `auto` in the UI (first configured, Pexels preferred); the API accepts an explicit source if you want a picker later.
- Scenes reuse clips from their start when footage runs short (no random sub-clip offsets yet).
- Subtitle rendering for scripts without an installed font falls back to no subtitles rather than tofu boxes.
- Admin UI card for stock-source keys not included — endpoints only, same as the video-gen provider keys (cloning the image-gen card in `admin/ai-tab.tsx` remains the quick follow-up).
