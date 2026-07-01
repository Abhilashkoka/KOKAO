---
name: X (Twitter) publishing in SocialForge
description: How X/Twitter credentials and publishing extend the Meta credential framework.
---

# X (Twitter) publishing in SocialForge

X reuses the Meta social-credential framework (see meta-credential-framework.md); it is NOT a parallel system.
- App-level: `apiKey`/`apiSecret` (consumer key/secret) in `app_credentials` (`provider: "twitter"`), superadmin-only, auto-tested via OAuth2 client_credentials bearer.
- Per-tenant: `accessToken`/`accessTokenSecret` (OAuth 1.0a user tokens) on `connected_accounts` (`platform: "twitter"`), auto-tested via GET /2/users/me.
- Publishing (`routes/twitter.ts`): optional image → v2 media upload (`uploadTwitterMedia` in twitterApi.ts) → media_id string, then POST /2/tweets JSON. All signed OAuth 1.0a.

**v1.1 media upload is DEAD (sunset 2025-06-09):** `upload.twitter.com/1.1/media/upload.json` was permanently retired — the old image path always 502'd. Media now goes through the v2 command flow at `https://api.x.com/2/media/upload`: INIT (form-urlencoded, signed) → APPEND (multipart, UNSIGNED body) → FINALIZE (form-urlencoded, signed); the media id is `data.id` (a string, not the old numeric `media_id_string`). v2 media upload officially expects OAuth 2.0 user-context (`media.write` scope); OAuth 1.0a still works but is unofficial/unreliable — a full fix is OAuth 2.0 PKCE. Text-only tweets via `/2/tweets` with OAuth 1.0a are unaffected and reliable.

**OAuth 1.0a signing gotcha:** JSON and multipart request bodies are NOT folded into the signature base string — pass `{}` as the params arg for those (this is why APPEND's multipart body is unsigned). Only query-string / form-urlencoded params go into the base string. Secrets go in Authorization header / body, never the URL.

**Testing:** `routes/twitter.test.ts` mounts the twitter router via `test/testApp.ts` — any NEW publish router must be added to `createTestApp()` or every route silently 404s (default Express not-found), which masquerades as a gating/lookup failure.

**Why:** X's 4-token OAuth 1.0a model (app consumer pair + per-user token pair) maps onto the existing app-creds + tenant-creds split, so no new tables were needed. Publishing depends on app creds for signing (unlike Meta which uses the page token directly), so the publish route must require `isTwitterAppConfigured()`.
