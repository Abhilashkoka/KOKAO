---
name: X (Twitter) publishing in SocialForge
description: How X/Twitter OAuth 2.0 PKCE connect + publishing works, and the OAuth 1.0a legacy path.
---

# X (Twitter) publishing in SocialForge

X connect + publishing runs entirely on **OAuth 2.0 PKCE** (migrated away from OAuth 1.0a). It still lives beside the Meta credential framework (app-level row + per-tenant connected_accounts row) but the token model is different.

- App-level: `clientId`/`clientSecret` (OAuth 2.0 confidential client) in `app_credentials` (`provider: "twitter"`), superadmin-only. There is NO live pre-test — a confidential client can't be validated without a full user authorization, so presence of the row is the "configured" signal. Admin UI shows the callback URL to register in the X app.
- Per-tenant connect: OAuth 2.0 PKCE authorization-code flow (`routes/twitter.ts` `GET /twitter/auth/url` → `GET /twitter/auth/callback`). Scopes: `tweet.read tweet.write users.read media.write offline.access` (offline.access yields the refresh token). Tokens stored ENCRYPTED as `{accessToken, refreshToken}` in `connected_accounts.encryptedCredentials`; expiry in `tokenExpiresAt`; X user id in `providerUserId`; the plaintext `accessToken` column is set null.
- PKCE verifier survives the redirect via an HMAC-signed, short-lived `state` (`tenantId.timestamp.verifier` + sig, base64url). `verifyState` must split into exactly 3 parts (verifier is base64url and dot-free) and use `lastIndexOf(".")` for the sig.
- Token refresh on demand: `ensureFreshTwitterToken(tenantId, app)` returns `{ok, accessToken, accountName} | {ok:false, reason:"not_connected"|"reconnect_required", message}`. Refreshes ~60s early via Basic-auth (`refreshTwitterTokens`) and persists the new token; never throws.
- Publishing (`routes/twitter.ts` `POST /content/:id/publish-twitter`): optional image → v2 media upload (`uploadTwitterMedia`) → media_id, then `POST /2/tweets` JSON. **Everything authorizes with `Bearer <accessToken>` — no request signing.**

**Legacy OAuth 1.0a prompts reconnect:** an old creds blob is detected by the presence of `accessTokenSecret`; `ensureFreshTwitterToken` returns `reconnect_required` for it (before the verifyStatus check) so the user is told to reconnect. Do NOT try to keep OAuth 1.0a publishing working.

**v1.1 media upload is DEAD (sunset 2025-06-09):** media goes through the v2 command flow at `https://api.x.com/2/media/upload`: INIT (form-urlencoded) → APPEND (multipart) → FINALIZE (form-urlencoded), all with the OAuth 2.0 bearer token (`media.write` scope); media id is `data.id` (string).

**Endpoints:** auth `https://twitter.com/i/oauth2/authorize`; token `https://api.x.com/2/oauth2/token` (Basic client auth for both code-exchange and refresh); user lookup `GET https://api.x.com/2/users/me`.

**Out of scope (do not add):** a twitter "retest"/re-verify endpoint — confidential-client creds have no live test.

**Testing:** `routes/twitter.test.ts` mounts the twitter router via `test/testApp.ts` — any NEW publish router must be added to `createTestApp()` or every route silently 404s (masquerades as a gating failure). Tests mock `globalThis.fetch` and route by URL: the `/2/oauth2/token` branch returns a refreshed token so the token-refresh path is exercised. Publish gate messages: no app creds → 400 `/administrator/i`; not connected / failed / legacy / expired-without-refresh → 400 containing "not connected or not verified".

**Why:** X's v2 media upload requires OAuth 2.0 user-context; OAuth 1.0a was unofficial/unreliable for uploads and eventually broke, so the whole connect+publish path moved to OAuth 2.0 PKCE with on-demand refresh.
