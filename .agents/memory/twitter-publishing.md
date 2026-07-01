---
name: X (Twitter) publishing in SocialForge
description: How X/Twitter credentials and publishing extend the Meta credential framework.
---

# X (Twitter) publishing in SocialForge

X reuses the Meta social-credential framework (see meta-credential-framework.md); it is NOT a parallel system.
- App-level: `apiKey`/`apiSecret` (consumer key/secret) in `app_credentials` (`provider: "twitter"`), superadmin-only, auto-tested via OAuth2 client_credentials bearer.
- Per-tenant: `accessToken`/`accessTokenSecret` (OAuth 1.0a user tokens) on `connected_accounts` (`platform: "twitter"`), auto-tested via GET /2/users/me.
- Publishing (`routes/twitter.ts`): optional image → v1.1 `upload.twitter.com` multipart → media_id, then POST /2/tweets JSON. Both signed OAuth 1.0a.

**OAuth 1.0a signing gotcha:** JSON and multipart request bodies are NOT folded into the signature base string — pass `{}` as the params arg for those. Only query-string / form-urlencoded params go into the base string. Secrets go in Authorization header / body, never the URL.

**Why:** X's 4-token OAuth 1.0a model (app consumer pair + per-user token pair) maps onto the existing app-creds + tenant-creds split, so no new tables were needed. Publishing depends on app creds for signing (unlike Meta which uses the page token directly), so the publish route must require `isTwitterAppConfigured()`.
