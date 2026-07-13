---
name: Clerk 401s from duplicate cookie shadowing
description: Browser looks signed in but every API call 401s (even after fresh sign-in); superadmin nav quietly disappears.
---

Root cause found (July 2026 incident): the browser held DUPLICATE Clerk cookies (`__session`, `__client_uat`, `__clerk_db_jwt` each present twice — same name set on overlapping domain/path scopes). The stale duplicate shadows the fresh one, so the server sees an expired JWT on every request — including requests made right after a fresh sign-in. Clerk auth reason: `session-token-expired-refresh-non-eligible-no-refresh-cookie`, message "JWT is expired".

**Why:** client-side Clerk state and server-side token verification disagree; React Query then has no `/me` data, so role-gated UI silently vanishes instead of erroring. A naive "sign out on 401" guard loops forever because re-signing-in does not remove the shadowing stale cookie.

**How to apply:**
- When a gated feature "disappears" or sign-in seems to bounce, check server logs for `clerk auth rejected` warnings (requireTenant logs auth reason + cookie names). Duplicate cookie names in the log confirm shadowing.
- Server self-heal exists: on token-expired + duplicate Clerk cookies, requireTenant responds 401 AND expires all Clerk cookies on host-only and Domain scopes, so the next sign-in starts clean. The frontend session guard (signOut on /me 401, one-shot latch) is safe only because of this self-heal.
- The e2e subagent's `runTest({testClerkAuth:true, testPlan})` OVERRIDES real Clerk auth — it cannot reproduce real-token failures. Real automated sign-in is blocked by Cloudflare's human check on Clerk dev instances.
