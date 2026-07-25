---
name: Reference video style profiles
description: Upload-once analyzed style profiles that steer topic video scripts.
---

- A reference video is analyzed ONCE (ffmpeg-measured pacing + vision-described hook/caption treatment) into a `video_style_profiles` row; generation only reads the saved payload — never the video.
- Analysis costs one caption unit: funding is reserved before analysis and refunded on failure; upload existence/size checked before reserving.
- **Why:** re-analyzing per generation would be slow and re-meter; profiles are the cache.
- **How to apply:** style guidance is soft — brand rules and the explicit prompt always win; `styleProfileId` is topic-engine-only and dropped server-side when the `referenceStyles` kill switch is off (fail-open in jobRunner so in-flight jobs still render).
