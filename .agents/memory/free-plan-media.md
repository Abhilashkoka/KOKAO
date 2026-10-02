---
name: Free plan media access
description: Free users keep AI posts and images; video visuals are stock-only.
---
Free accounts can spend their one-time credits on AI post and image generation. Video Studio is stock-only for free accounts, even when they purchase credits. AI scripts and narration may use applicable credits; stock visuals must not incur AI visual-generation charges.

**Why:** The user initially requested stock-only images too, then explicitly revised that restriction to keep AI images available on the free tier. They selected charging only AI script/narration for stock videos.

**How to apply:** Do not block standalone AI images when enforcing video restrictions. Check current plan at server execution/provider boundaries, not only UI or credit balance. Do not silently fall back from stock footage to AI visuals. Keep paid-plan access unchanged.

Free stock videos require the existing enforced-credit funding rail. **Why:** waiving the aggregate video charge on a legacy quota/shadow rail would also make paid AI scripts and narration uncharged. **How to apply:** fail explicitly on legacy billing; do not silently enable the global credit rollout. Retries must preserve a valid enforced-credit funding snapshot.