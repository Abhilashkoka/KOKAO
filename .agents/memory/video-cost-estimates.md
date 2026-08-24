---
name: Video cost estimates
description: Rules for presenting pre-generation video-model costs without misrepresenting wallet reservations.
---

Show the active provider/model-and-duration estimate separately from the flat up-front wallet reservation. Include the configured platform fee in the model estimate, label it approximate, and show the estimate as unavailable if any required video model lacks a usable catalog price.

**Why:** The flat reservation protects the wallet from concurrent spending; it is not evidence of the provider's likely cost. Final settlement uses measured provider output/receipts when available, so presenting the reservation as an estimate gives users a confidently wrong number.

**How to apply:** Keep balance shortfall checks based on the reservation, but describe that amount as a reservation. Build the approximate model amount only from server-owned active model identities and catalog rates. Mention unpriced components such as narration/music and never invent a blended fallback total.