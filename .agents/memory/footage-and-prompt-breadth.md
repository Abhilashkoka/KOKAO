---
name: Footage & prompt breadth
description: Keyless stock sources (Wikimedia Commons) and the deterministic image Look/prompt compiler — durable rules.
---

- Keyless stock sources are failover-only in "auto": they join the auto candidate list only when at least one keyed library is configured; explicit tenant selection is always allowed. Health ordering applies across keyed+keyless together.
  **Why:** keyless archival footage (PD/CC0 only) is a safety net, not a primary library — quality and coverage are worse.
  **How to apply:** add new keyless sources with `envKey: null` in the stock source registry; never let them promote themselves into auto without a keyed source present.
- Stock failover treats EMPTY results the same as errors — the candidate walker moves to the next source on both. Preflight must derive its health keys from the same candidate list the runtime walks (parity), never a hardcoded source list.
- Image "Look" pills compile server-side in the routes so the STORED prompt is the finished text (deterministic compiler, no AI call). Kill switch off = drop the recipe before compiling so the prompt goes out exactly as typed (fail-open, exact pre-feature behavior).
- Pill vocabularies live as OpenAPI enums with a zod drift test — extend the enum, run codegen, and the drift test keeps server/client vocab in lockstep.
