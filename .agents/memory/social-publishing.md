---
name: Social publishing in SocialForge
description: How "connected accounts" relate to actual publishing across platforms.
---

# Social publishing in SocialForge

"Connect Account" (routes/accounts.ts) is RECORD-ONLY: it just stores a label row in `connected_accounts`. It does not log in, do OAuth, or grant posting permission. Scheduling is also record-only.

Real publishing is built per-platform in dedicated routes, NOT through the generic accounts flow:
- Facebook + Instagram: `routes/meta.ts` (publish) + `routes/credentials.ts` (credential CRUD). Uses a reusable social-credential framework (see meta-credential-framework.md). Do NOT use env `FACEBOOK_PAGE_ACCESS_TOKEN` — the old env-token `routes/facebook.ts` was removed.
- LinkedIn: `routes/linkedin.ts` (real 3-legged OAuth, stores token on the tenant's `linkedin` connected_accounts row). See linkedin-publishing.md.

`connected_accounts` also carries per-platform encrypted publish credentials (`encryptedCredentials` JSON + `verifyStatus`/`verifiedAt`/`verifyError`), plus the older nullable OAuth-token columns used by LinkedIn. A tenant row can be label-only or publish-capable.

**Why:** Avoids re-discovering that connecting an account ≠ being able to post; each platform needs its own real credential/publish path.
