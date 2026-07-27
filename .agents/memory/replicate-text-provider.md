---
name: Replicate text-gen provider
description: How the "replicate" text provider works — OpenAI-client shim over the predictions API, shared video-gen key, pricing scraping.
---

- **Replicate has NO OpenAI-compatible chat endpoint** (verified live: /v1/chat/completions and variants 404). The text provider works through a custom-fetch OpenAI client (`replicateTextGen.ts`) translating chat.completions → `POST /v1/models/{owner}/{name}/predictions`.
- Universal LLM inputs on Replicate: `prompt`, `system_prompt`, `max_tokens`. Anything else risks a 422 (models reject unknown inputs) — do not forward temperature etc.
- `response_format: json_object` is emulated with a system instruction; there is no native JSON mode.
- Streaming: prediction `stream: true` → SSE at `urls.stream` (events `output` / `error` / `done`). **EOF before the `done` event must reject the stream** — treating it as end-of-output silently truncates completions (architect-flagged bug, fixed + unit-tested with a stubbed global fetch).
- Usage: prediction `metrics.token_input_count/token_output_count` (fetched from `urls.get` after streaming when include_usage is set); best-effort.
- Key is deliberately SHARED with video generation (`videogen_replicate` credential, env fallback `REPLICATE_API_TOKEN`). **Why:** one key, one place to rotate; the admin UI's text-gen card points to the Video Generation card instead of taking its own key.
- Token pricing for Replicate LANGUAGE models comes from the same model-page scrape as video pricing: entries titled "per million input/output tokens". `lookupReplicateTokenPricing` returns the OpenRouter-shaped {inputPerMTokens, outputPerMTokens} so the UI shares one display path.
- Account with <$5 credit is throttled to ~6 predictions/min — live probes may 429; wait and retry.
