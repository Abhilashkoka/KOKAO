---
name: Per-plan KOKAO watermark
description: How the "Made with KOKAO.in" watermark is gated and applied to AI images and videos
---

- Gating is per-plan (`plan_settings.watermark`, admin Plans-tab switch) AND the platform-wide `freeWatermark` kill switch (id kept for data compat; label now "Plan Watermark"). Both must be on.
- DEFAULT_PLANS: only `free` defaults to watermark=true; the DB column defaults false so pre-existing custom rows are unaffected. An override row for `free` saved via the admin UI inherits the previous value (update route falls back to `previous.watermark` when the field is omitted).
- Images: single choke point `performImageGeneration` (sharp pill composite, fail-soft).
- Videos: single choke point `executeVideoJob` after the QA gate and BEFORE upload/poster extraction — so storyboard-resume paths and thumbnails inherit it automatically. ffmpeg overlay bottom-right, audio `-c:a copy`, fail-soft to the unwatermarked buffer.
- **Why** the placement matters: watermarking after poster extraction would ship an unwatermarked thumbnail; watermarking before QA would let a watermark failure fail a paid render.
- **How to apply:** any new video engine or delivery path must land its final buffer through `executeVideoJob`'s upload block, or it silently skips the watermark.
- Plan audit logs (`plan_edit`/`plan_create`) include the watermark value in old/new payloads.
