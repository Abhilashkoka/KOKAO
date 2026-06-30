---
name: Social publishing in SocialForge
description: How "connected accounts" relate to actual publishing across platforms.
---

# Social publishing in SocialForge

"Connect Account" (routes/accounts.ts) is RECORD-ONLY: it just stores a label row in `connected_accounts`. It does not log in, do OAuth, or grant posting permission. Scheduling is also record-only.

Real publishing is built per-platform in dedicated routes, NOT through the generic accounts flow:
- Facebook: `routes/facebook.ts` (uses `FACEBOOK_PAGE_ACCESS_TOKEN`). Was blocked on the token lacking `pages_manage_posts`.
- LinkedIn: `routes/linkedin.ts` (real 3-legged OAuth, stores token on the tenant's `linkedin` connected_accounts row). See linkedin-publishing.md.

`connected_accounts` gained nullable token columns (`accessToken`, `tokenExpiresAt`, `providerUserId`) so a row can be either a label-only record (token null) or a real publish-capable connection. `serializeAccount` exposes `canPublish` = token present AND not expired; the UI shows "Ready to publish" vs "Connected".

**Why:** Avoids re-discovering that connecting an account ≠ being able to post.
