---
name: Image generation provider framework
description: Pluggable admin-selected image providers mirroring the ASR framework; SSRF rules for the custom OpenAI-compatible provider.
---

- The app has a superadmin-selectable image generation provider (like ASR): singleton selection row, keys in encrypted `app_credentials` rows, DB key wins over env secret, clients only see `keySource`.
- **Custom OpenAI-compatible provider is an SSRF vector.** Any admin-entered base URL AND any provider-returned image URL must be validated with the shared `assertPublicHost` guard, https-only, `redirect: "manual"`.
  **Why:** the server fetches these URLs with credentials; without the guard a malicious base URL or response can probe internal hosts.
  **How to apply:** when adding providers that take user/admin URLs or download from returned URLs, run them through the same guard.
- BFL (FLUX) provider is async: submit returns a `polling_url` to poll until Ready, then a short-lived result URL to download — both provider-returned URLs go through the same SSRF guard, and the model id doubles as the URL path segment so it must be regex-validated.
- Providers can carry suggested `modelOptions` (value+label) in the catalog, exposed via the admin API and shown as a Select above the free-text model input — that's how "Nano Banana Pro" (gemini-3-pro-image-preview) is surfaced without a new provider.
- UI pattern gotcha: a "draft provider" select (custom needs baseUrl+model before saving) must clear the draft when the user re-selects the saved provider and on successful save, or the card gets stuck in "Not saved yet".

## Third-party media URLs are untrusted
Any URL that arrives inside a provider/stock API response (image result URLs, stock clip renditions) must pass the SSRF guard before a server-side fetch: https-only, assertPublicHost, and manual redirect following with re-validation per hop. External patches tend to skip this — check it on review.

## Provider select must draft, never save-on-select
Image/video provider cards must enter DRAFT mode when a provider supports model override — saving on select runs the activation pricing gate on the provider's DEFAULT model, and Replicate's default image model (black-forest-labs/flux-schnell) has NO published/scrapable price, so the provider 400'd instantly and could never be selected. Drafts fall back to empty model/base-url inputs (saved values belong to the previous provider) and are discarded when a refetch changes the saved provider.
**Why:** prod incident: admin could not switch the image provider to Replicate at all.
**How to apply:** any new gen-settings card with a pricing/activation gate: gate on the user's chosen model at explicit Save, not on dropdown change.
