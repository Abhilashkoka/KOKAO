---
name: Video cost estimates
description: Rules for presenting pre-generation video-model costs without misrepresenting wallet reservations.
---

Show the active provider/model-and-duration estimate separately from the flat up-front wallet reservation. Include the configured platform fee in the model estimate, label it approximate, and show the estimate as unavailable if any required video model lacks a usable catalog price.

**Why:** The flat reservation protects the wallet from concurrent spending; it is not evidence of the provider's likely cost. Final settlement uses measured provider output/receipts when available, so presenting the reservation as an estimate gives users a confidently wrong number.

**How to apply:** Keep balance shortfall checks based on the reservation, but describe that amount as a reservation. Build the approximate model amount only from server-owned active model identities and catalog rates. Mention unpriced components such as narration/music and never invent a blended fallback total.

Variant-priced video rows must use the same canonical request vocabulary as runtime criteria, especially `inputMode: "non_video"` (underscore). Normalize legacy `non video`, `non-video`, and `nonvideo` spellings both when saving and matching.

**Why:** Variant matching is deliberately exact; a manually entered space instead of an underscore made a valid provider/model price invisible and repeatedly blocked preflight.

**How to apply:** Keep a row for the exact base runtime criteria as well as more-specific audio/resolution rows when conditional pricing is enabled. Once conditional rows exist, an unmatched generic row is intentionally unavailable.