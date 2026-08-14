---
name: Model JSON output parsing
description: Why all AI-route model-output JSON parsing must use the tolerant shared parser
---

**Rule:** Never `JSON.parse` raw chat-completion output directly in AI routes. Use the shared `parseModelJsonObject` helper (exported from the ai router): direct parse → every ```json fence → string/escape-aware balanced-brace scan. Returns null (never throws); callers keep explicit fallbacks (e.g. caption/summarize/research fall back to raw text).

**Why:** Production incident — DeepSeek (`deepseek-ai/deepseek-v3.1`) wrapped its JSON reply in prose/markdown fences despite `response_format: json_object`, so carousel generation parsed 0 slides on both attempts and returned a bare 500.

**How to apply:**
- New generation flows that parse model JSON must call the helper and decide explicitly what a null parse means (refund + error vs raw-text fallback).
- Never log raw model output snippets (user briefs = PII); log lengths + `Object.keys(parsed ?? {})` instead.
- The carousel route also has a one-shot retry when parsed slides (validated: heading OR body present) < slideCount and no clarifyingQuestions.
- Incremental/partial SSE extraction is intentionally NOT run through the helper — only terminal parses.
