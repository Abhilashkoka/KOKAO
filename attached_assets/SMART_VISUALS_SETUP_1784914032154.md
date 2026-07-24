# KOKAO Smart Visuals — vision-ranked stock + AI b-roll

The answer to "can it scrape the internet for the right footage?" — built the safe way. Instead of scraping (which would put copyrighted media into your customers' published marketing posts — a DMCA liability you don't want), this patch makes the AI *see* and *choose* footage, and adds a mode where every visual is generated and fully owned.

## Apply it (on top of video-quality.patch)

```bash
git am smart-visuals.patch
```

No new dependencies, no schema change, no new secrets. Restart the app.

## 1. Vision-ranked stock — "AI identifies the correct video"

Until now the pipeline trusted keyword search blindly: five English search terms, first acceptable clips win, scenes cycle through them in order. Now:

- Every Pexels/Pixabay candidate carries its thumbnail frame
- One vision call shows your tenant's AI model all candidate thumbnails **plus the narrated scenes**, and asks it to assign the best-matching clip to each scene — judging the *footage*, not the keywords, preferring visual variety, and skipping watermarked frames
- Each sentence is then pinned to its chosen clip in the composition

This especially fixes non-English topics (your local-language scripts), where translated search terms match poorly but a vision model judging thumbnails doesn't care what language the topic was in.

**Strictly fail-soft:** if the model isn't vision-capable, times out, or returns nonsense, the video renders exactly as before. Ranking can only improve a video, never fail one.

## 2. AI b-roll — a third visuals mode, "AI imagery"

Next to *Stock footage* and *Your character* there's now **AI imagery**: an art-direction LLM pass writes one photorealistic prompt per scene (consistent mood, no text/watermarks/brands), your existing image provider generates each scene's visual, and each still becomes a Ken Burns clip sized to its scene — flowing into the same narration/subtitles/ducked-music composition.

- Fully owned output: no stock license, no attribution question, always on-topic
- Priced at **2 video units per paragraph** (half the character rate — images only, no image-to-video calls); the UI shows the cost next to the toggle
- Works with whichever image provider your admin has selected (all 8)

## Why not scraping (for the record)

Technically trivial, commercially dangerous: media scraped from Google/YouTube/Instagram is copyrighted by default, and KOKAO would be auto-inserting it into customers' *published commercial posts*. Pexels/Pixabay + generated imagery give you the relevance without exposing your users. If you later want more breadth, the right next source is **Openverse** (an API over 800M+ Creative Commons works with license filters) — it slots straight into the existing stock-source registry; say the word.

## Verified

- 63 API tests green (videoGen suites + routes), including real-ffmpeg Ken Burns clip generation and unit-pricing checks; ranking fail-soft covered by tests
- 9 video-studio page tests green; API + web typecheck clean; spec lint + codegen drift clean
