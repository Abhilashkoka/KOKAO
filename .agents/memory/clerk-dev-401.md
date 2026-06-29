---
name: Clerk dev 401s from frozen session token
description: Why authenticated API calls 401 in the dev preview even though keys/code/instance are all correct
---

# Clerk dev 401: present-but-expired session cookie that never refreshes

Symptom: every authenticated API call returns 401 in the dev preview. The frontend
still renders signed-in UI, the `__session` (and `__client`) cookie DOES reach the
server, but `getAuth(req)` returns `userId: null`.

When this happens, do NOT keep restarting workflows or theorizing about key/code bugs.
Decode the `__session` JWT payload server-side (base64url of `parts[1]`) and inspect
`iss`, `iat`, `exp`, `nbf` vs `Date.now()/1000`. The telltale finding: the token is
valid-but-EXPIRED, from the CORRECT instance (`iss` matches the publishable key's
domain), and its `iat` never changes across many requests over many minutes.

**Root cause:** Clerk dev-mode session tokens live ~60s and must be silently refreshed
by Clerk's browser SDK against the dev Frontend API (`*.clerk.accounts.dev`), which is
a DIFFERENT domain from the app (`*.replit.dev`). Strict browser third-party
cookie/storage blocking stops that background refresh, so the cookie freezes at an
expired token and the server correctly rejects it. Opening the app in a new tab does
NOT fix it — the app becomes first-party but the Clerk FAPI is still third-party.

**Why it's not a code bug:** verified `app.ts` clerkMiddleware block + `App.tsx`
ClerkProvider wiring matched the canonical clerk-auth skill snippets exactly;
`VITE_CLERK_PUBLISHABLE_KEY` == `CLERK_PUBLISHABLE_KEY` (same instance), secret key
same env; container/Clerk/Google clocks all agreed (no skew).

**Fixes (in order of reliability):**
1. Production: published apps route Clerk through the same-domain proxy
   (`/api/__clerk`), making FAPI first-party — refresh works, issue vanishes. The proxy
   is production-only by design; do NOT enable it in dev.
2. Dev workaround: clear the site's cookies + site data (drops the stale dev-browser
   JWT and `__client`), allow third-party cookies for the site / `clerk.accounts.dev`
   (or use a browser without strict tracking protection), then sign in fresh.

**How to apply:** confirm via the decoded-claims log first; if `expired:true` with a
stale unchanging `iat`, it's this — stop debugging server/keys and move to the browser
or production fix. Remove any temporary debug logging from `requireTenant.ts` after.
