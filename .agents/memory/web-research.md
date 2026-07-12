---
name: In-app web research
description: How live web search works in this project without external search APIs (Tavily etc.)
---

The Replit OpenAI AI-integrations proxy supports the Responses API `web_search` tool (verified with a live request). This means live web search with citations needs NO external search provider (no Tavily/SerpAPI key).

**Why:** User asked to build a Tavily equivalent in-app; testing showed the existing proxy already provides grounded search with `url_citation` annotations.

**How to apply:** Call `openai.responses.create({ model, tools: [{ type: "web_search" }], ... })` via the existing `@workspace/integrations-openai-ai-server` client. Collect sources from `output[].content[].annotations` where `type === "url_citation"` (validate http/https before returning to clients). The model's `output_text` may wrap JSON in prose — extract the outermost `{...}` before parsing.
