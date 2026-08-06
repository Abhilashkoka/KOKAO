---
name: Custom AI providers
description: Admin-added OpenAI-compatible providers selectable for text/image/video via "custom:<id>" refs.
---

Superadmins can add OpenAI-compatible providers (name, https base URL, encrypted optional key, per-use-case toggles) from Admin → AI; they become selectable in the existing text/image/video provider dropdowns as `custom:<id>`.

**Rules that must hold:**
- Provider refs are the string `custom:<id>` stored in the same free-text provider columns as builtin providers. Any *static* provider lookup (`getXGenProviderDef`, `IMAGE_GEN_PROVIDERS` walks, preflight capability checks) misses customs — use the async `resolveXGenProviderDef` variants or explicitly add the current selection when it's custom.
- Dynamic defs must override the runtime result's `provider` field back to `custom:<id>`; the underlying generic adapters report their own id ("custom"/"openrouter"), which mis-attributes usage/cost rows and can misprice on model-only fallback.
- Keyless endpoints get a placeholder bearer ("no-key-required"); the key lives encrypted on the provider row, never in app_credentials/env.
- Selection fail-soft: text selection silently reads as builtin if the row is deleted or the use-case toggle is off; routes refuse DELETE / toggle-off while a use case still points at the provider.
- Base URLs pass the shared SSRF guard (https + assertPublicHost). Models/prices are entered in the existing per-use-case cards; the activation pricing gate (manual price rows) applies unchanged.
- Custom providers are never auto-routing/failover candidates for images; video defaults to the OpenRouter-shaped async video generator with a baseUrl override.
- Video API shape is chosen per provider row: the OpenRouter shape by default, or an admin-described mapping (endpoint + dot-path fields) driven by a generic mapped adapter. Mapping problems are terminal not-configured errors (never breaker-recorded), validated with user-facing messages on write AND re-checked at generate time. In the mapped adapter, a submit response with a job id but NO status field must count as pending and be polled — id-only submits are a common async pattern.

**Why:** one generic "custom" slot would collide across use cases; identity-preserving refs keep cost attribution, health keys, and audit trails consistent.
