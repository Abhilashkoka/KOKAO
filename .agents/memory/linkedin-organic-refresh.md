---
name: LinkedIn organic silent token refresh
description: How organic LinkedIn posting connections auto-renew via stored refresh tokens (mirrors the ads refresh pattern).
---

Organic LinkedIn connections (`connectedAccounts`) now auto-renew like LinkedIn ADS connections do.

**The rule:** a LinkedIn reconnect prompt may only appear when the REFRESH token is dead (rejected 400/401, past its own expiry with a lapsed access token, or absent). A lapsed/rejected ACCESS token must first get one silent refresh attempt; transient refresh failures (5xx/network/unconfigured app creds) leave the row untouched for the next sweep.

**Why:** LinkedIn member tokens expire ~60 days; the programmatic refresh token lasts ~1 year. Flipping to failed on access-token expiry forced needless reconnects.

**How to apply:**
- Storage layout differs from ads: organic keeps the access token in the row's `accessToken`/`tokenExpiresAt` columns; only `{refreshToken, refreshTokenExpiresAt}` lives encrypted in `encryptedCredentials`. Ads keeps everything in the encrypted blob.
- The refresh core lives in `lib/linkedinOrganicRefresh.ts`; `reverifyLinkedin` calls it first (so sweep + Accounts page + pre-publish force-reverify all get it), and routes its 401/403 probe branch through `handleLinkedinOrganicAuthFailure`.
- The OAuth callback overwrites `encryptedCredentials` on every connect (null when LinkedIn returns no refresh_token) so stale refresh tokens never linger; disconnect/failed-retest clear it.
- LinkedIn only returns refresh_token when the developer app has the programmatic-refresh-token feature — code must tolerate its absence (legacy behavior: expiry = reconnect prompt).
