---
name: Social publishing in SocialForge
description: How "connected accounts" relate to actual publishing across platforms.
---

# Social publishing in SocialForge

"Connect Account" (routes/accounts.ts) is RECORD-ONLY: it just stores a label row in `connected_accounts`. It does not log in, do OAuth, or grant posting permission. Scheduling is also record-only.

Real publishing is built per-platform in dedicated routes, NOT through the generic accounts flow:
- Facebook + Instagram: `routes/meta.ts` (publish) + `routes/credentials.ts` (credential CRUD). Uses a reusable social-credential framework (see meta-credential-framework.md). Do NOT use env `FACEBOOK_PAGE_ACCESS_TOKEN` — the old env-token `routes/facebook.ts` was removed.
- LinkedIn: `routes/linkedin.ts` (real 3-legged OAuth, stores token on the tenant's `linkedin` connected_accounts row). See linkedin-publishing.md.
- X (Twitter): `routes/twitter.ts` (publish) + `routes/credentials.ts` (credential CRUD), same framework as Meta. OAuth 1.0a user-context: app-level consumer key/secret (admin, superadmin-gated) + per-tenant access token/secret. BOTH are needed to sign every request, so tenant test/publish loads the app creds first (like IG needs the FB token). Signer + testers in `lib/twitterApi.ts`. Media via v1.1 upload, tweet via POST /2/tweets; image optional (unlike IG). See meta-credential-framework.md for the shared credential pattern.

`connected_accounts` also carries per-platform encrypted publish credentials (`encryptedCredentials` JSON + `verifyStatus`/`verifiedAt`/`verifyError`), plus the older nullable OAuth-token columns used by LinkedIn. A tenant row can be label-only or publish-capable.

**Why:** Avoids re-discovering that connecting an account ≠ being able to post; each platform needs its own real credential/publish path.

## Auto re-verification of stored tokens

Stored tokens are re-checked automatically (not only via the manual "Re-test now" button): on the Accounts page GET (`/social-credentials/{facebook,instagram}`, `/linkedin/status`) and forced right before each publish. Meta helpers live in `lib/socialReverify.ts` (`reverifyFacebook`/`reverifyInstagram`); LinkedIn has its own `reverifyLinkedin` in `routes/linkedin.ts` (live `userinfo` check).

Rules that matter:
- **Staleness gate is the rate limiter** (`REVERIFY_STALE_MS`, 15 min) — `verifiedAt` doubles as "last checked at", so bursty page loads don't hammer the platform APIs. `force:true` bypasses it for publishes.
- **Never flip a valid token to "failed" on a transient/network error.** `TestResult.transient` marks network failures (Meta helpers); on transient we only reset the check clock, keeping prior status. LinkedIn only flips on 401/403 from userinfo.
- LinkedIn reuses `verifyStatus`/`verifiedAt` (previously unused for it); OAuth callback must set `verifyStatus:"verified"` or a reconnected account stays computed as not-connected. `LinkedInStatus.expired` (openapi) drives the "Reconnect needed" UI vs "Not connected".

**Why:** "Verified" was a lie once a token silently expired — users only found out when a publish failed. These triggers surface breakage proactively without spamming the APIs and without false alarms.
