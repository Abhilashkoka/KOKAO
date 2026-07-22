---
name: Actual AI cost tracking
description: Design invariants for per-tenant real AI cost capture (superadmin reporting).
---

- Costs are recorded per usage event in PAISE; anything unknown (no price row, unset USD→INR rate, missing tokens) stores NULL — never a guessed number. Report surfaces unknown-event counts so under-coverage is visible.
- **Why:** margin decisions based on silently-wrong estimates are worse than visibly-missing data.
- Price lookup falls back to a model-only match under any provider so one catalog row covers the same model via builtin AND openrouter.
- OpenRouter reports exact per-request USD cost when the request includes `usage: { include: true }`; that reported cost wins over the catalog estimate.
- Cost capture is best-effort (try/catch returning {}) and gated by the `aiCostTracking` kill switch — it must never break or block a generation.
- Tenant-facing display spend is SNAPSHOTTED per usage event at record time (per-unit rate with fee folded in) so admin rate changes never rewrite historical months; report sums snapshots and uses current rates only for pre-snapshot NULL rows. Snapshot lookup is best-effort — failure stores NULL, never blocks the generation.
- Saving a rate CHANGE first freezes all legacy NULL-snapshot rows at the OUTGOING rates (same tx), so history can never shift; first-time configuration skips the freeze so the initial rates apply retroactively.
- Campaign generation splits one completion's tokens/cost across per-platform usage rows (remainder on the first row) so per-tenant sums stay exact.

**Token-based image costing:** image price rows may carry token prices (in+out $/1M) alongside or instead of flat $/image; cost prefers token-based when the provider reported tokens (OpenAI gpt-image-1, Gemini usageMetadata), else flat, else null. Spec is OpenAPI 3.1 — use `type: ["number","null"]`, never `nullable: true` (lint fails).
