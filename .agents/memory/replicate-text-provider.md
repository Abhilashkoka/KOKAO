---
name: Replicate text provider
description: Pitfalls of the OpenAI-chat shim over Replicate's predictions API
---

**Rule:** The Replicate text shim must build model inputs from the model's OWN OpenAPI Input schema (fetched + cached per model). Replicate silently DROPS undeclared input fields — no 422, no warning.

**Why:** Production incident — `deepseek-ai/deepseek-v3.1` declares no `system_prompt` input, so every system instruction (JSON contract, brand rules) was silently discarded; the model answered the bare user prompt in free-form markdown and carousel generation 500'd on every attempt, even after tolerant JSON parsing.

**How to apply:**
- `system_prompt` only when declared; otherwise fold system text into the prompt (`system\n\n---\n\nuser`). Unknown/unreadable schema = fold (universally safe).
- Optional inputs (`max_tokens`) fail closed: omit unless the schema declares them.
- Schema cache: successes cached for process lifetime; failures retry after 60s (never permanently negative-cache a transient outage).
- No OpenAI chat endpoint exists on Replicate; the shim maps chat → predictions API. Stream EOF before the terminal "done" event must reject (truncation).
- Shares the video-gen Replicate key (stored under videogen_replicate).
- Same class of bug exists for video models: wrong/undeclared input field names vanish silently — always verify each model's schema.
