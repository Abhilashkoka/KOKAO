---
name: Image generation provider framework
description: Pluggable admin-selected image providers mirroring the ASR framework; SSRF rules for the custom OpenAI-compatible provider.
---

- The app has a superadmin-selectable image generation provider (like ASR): singleton selection row, keys in encrypted `app_credentials` rows, DB key wins over env secret, clients only see `keySource`.
- **Custom OpenAI-compatible provider is an SSRF vector.** Any admin-entered base URL AND any provider-returned image URL must be validated with the shared `assertPublicHost` guard, https-only, `redirect: "manual"`.
  **Why:** the server fetches these URLs with credentials; without the guard a malicious base URL or response can probe internal hosts.
  **How to apply:** when adding providers that take user/admin URLs or download from returned URLs, run them through the same guard.
- UI pattern gotcha: a "draft provider" select (custom needs baseUrl+model before saving) must clear the draft when the user re-selects the saved provider and on successful save, or the card gets stuck in "Not saved yet".
