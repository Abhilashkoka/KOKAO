---
name: Text-gen provider switch
description: Lessons from adding the builtin/OpenRouter text-generation routing layer
---

- The rule: text-generation provider selection follows the same pattern as ASR/imageGen (singleton settings row, encrypted `app_credentials` key with DB-wins-over-env, `keySource`-only exposure) — reuse that pattern for any future provider family.
- **Why:** user explicitly agreed there must be NO silent fallback: if OpenRouter is selected but the key or model list is missing, requests fail with a clear 503 (`TextGenNotConfiguredError`), never quietly reverting to builtin. Rollback is an explicit admin flip back to "builtin".
- **How to apply:** any new call site that needs text generation must go through `getTextGenClient`/`getTextGenOrRespond`, not raw OpenAI clients — except web-search-dependent endpoints (`/ai/research`), which stay on the builtin Responses API because OpenRouter has no web_search tool.
- Tenant model persistence: tenants keep their saved model string; `resolveTextModel` maps it onto whatever the active provider serves so switching providers strands nobody.
