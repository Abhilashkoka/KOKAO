---
name: Live text model compatibility
description: Compatibility rules for models used by synchronous text-generation flows.
---

Models activated for live text generation must support the provider's synchronous chat-completions endpoint. Reject OpenRouter `:batch` variants before pricing or persistence. When reading a legacy OpenRouter selection, exclude batch-only variants and fall back to the built-in provider if none remain.

**Why:** A valid, priced, authenticated batch-only model can still return 404 from the chat endpoint and simultaneously break script intake, spokesperson writing, and other real-time generation.

**How to apply:** Validate endpoint compatibility separately from model existence and pricing. Never silently strip a batch suffix because the corresponding real-time model may not exist; reject new settings and fail safely when reading old ones.