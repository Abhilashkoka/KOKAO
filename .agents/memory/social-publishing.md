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

## Proactive breakage notifications

When a stored social token transitions verified -> failed, a one-time in-app notification is recorded (`notifications` table + `lib/notifications.ts` `notifySocialConnectionFailed`), shown as a dismissible banner in the web app layout and served by `routes/notifications.ts`. On a FRESH breakage the same choke point also emails the tenant's verified address (best effort) so inactive users learn before a post fails.

Email uses the Replit-managed SendGrid connector at runtime via `lib/email.ts` `sendEmail` (fetches api_key/from_email from the connectors proxy using REPL_IDENTITY/WEB_REPL_RENEWAL; NO hardcoded creds). It is a safe no-op returning false when SendGrid isn't connected — never throws, never blocks the reverify path. Recipient comes from `lib/clerkUser.ts` `fetchVerifiedEmail` (tenant.clerkUserId -> live verified Clerk email); reconnect link is absolute via `REPLIT_DOMAINS` + `/accounts`. Email dedup is inherited: it fires only after a new notification row is actually inserted (past the unread-dedupe guard), so a re-checked-but-still-broken token does not re-email.

Dedup ("once per breakage") is TWO-layered and relies on the transition, not a flag: (1) the call sites fire only when the PRIOR `verifyStatus === "verified"` and the new is `failed` (so a token that is already failed never re-notifies on repeated re-checks), and (2) the helper skips insert if an UNREAD notification of the same type+platform already exists. A reconnect (back to verified) then a later break is a NEW breakage → new notification. The Meta call site is inside `writeStatus` in `socialReverify.ts`; LinkedIn's is the 401/403 branch of `reverifyLinkedin`.

**Why:** users not actively in the app otherwise learn a connection died only when a post fails.

## Stale test gotcha

`routes/meta.test.ts` "with fetch mocked" tests expect 502 from publish-facebook, but the publish path force-reverifies first (`reverifyFacebook({force:true})`), and `testFacebookCredentials` treats a mocked 400 as a NON-transient failure → flips the account to `failed` → the gate returns 400, not 502. These 3 assertions are pre-existing/stale (predate the force-reverify-on-publish change), unrelated to notifications work. Adding a router to `test/testApp.ts` also requires updating that shared factory (only mounts a subset of routers).
