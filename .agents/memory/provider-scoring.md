---
name: Provider scoring & generation telemetry
description: Evidence-based provider routing (image/ASR) and the streamed-usage metering rules — durable decisions.
---

- Health is a PARTITION, not a scoring weight: ranking sorts healthy candidates first and appends breaker-open ones; scores only order within each group. Never fold breaker state in as a weighted axis — one weight tweak could route traffic to a provider the breaker already declared down.
- Cost is scored only relative to the other candidates and only when at least two are priced; a lone priced provider must not lose (or win) for the honesty of having a price on file. Unpriced = absent from the map, never zero/guessed. Price reads are NOT gated on the aiCostTracking flag — that flag governs reporting, not routing.
- Reliability uses shrinkage `(successes + 3×0.8)/(samples + 3)` and latency an EMA (α=0.3) so unknown providers score 0.8 (not 1.0) and one failure or one slow call doesn't reorder the world.
- Streamed OpenAI-compatible completions report NO usage block unless the request sends `stream_options: { include_usage: true }` — without it every streamed generation is metered with NULL tokens/cost. Always ask on streaming paths.
- Cached/reasoning token subsets are recorded but never discounted in cost; discounting needs its own price column, and an invented discount is worse than a visible overstatement (a test locks this).
- Kill switch `providerScoring` (fail-open): off = Auto selection degrades to the built-in default provider, and image/ASR fallbacks revert to breaker-health partition ordering. Admin may still store "auto" while off — safe because runtime degrades.
