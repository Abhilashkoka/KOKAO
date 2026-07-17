---
name: Swappable ASR providers & admin-entered keys
description: How speech-to-text provider selection and API key storage work; pitfalls when adding providers.
---

- Providers are a catalog in one place; each `transcribe(input, apiKey)` takes the key injected — never read `process.env` inside a provider. Key resolution is centralized: admin-entered DB key (encrypted `app_credentials` row `asr_<providerId>`) wins over the env secret fallback.
- **Why:** the superadmin can enter keys in the UI without redeploying; env secrets stay a working fallback for keys set before the UI existed.
- **How to apply:** when adding a provider, add it to the catalog only, give it an `envKey` (or null for built-in proxy providers), and let `resolveAsrApiKey` do the rest. `configured`/`keySource` in the admin API must stay derived from the same resolution path or the UI badges lie.
- Keys are never returned to clients — the API exposes only `keySource: database|env|null`. Don't add a masked-key field without thinking; the existing pattern is "replace or remove", not "view".
- Orval pitfall (already hit once): don't name a multipart request-body schema `<PascalOperationId>Body` — use a named component + $ref.
