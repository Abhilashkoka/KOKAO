---
name: Object storage default routes are unauthenticated
description: The object-storage scaffold ships private-object routes with auth/ACL disabled — must be gated before shipping.
---

The Replit object-storage scaffold's `routes/storage.ts` ships with:
- `GET /storage/objects/*` (private objects) — ACL/auth checks are present only as COMMENTED-OUT example code, so it serves private objects to anyone.
- `POST /storage/uploads/request-url` — mounted in the PUBLIC section, so unauthenticated clients can mint signed upload URLs.

**Rule:** before shipping, split the storage router into a public part (only `/storage/public-objects/*`) and a protected part (`/storage/uploads/request-url` + `/storage/objects/*`), and mount the protected part after the auth gate.

**Why:** leaving the defaults in place is an access-control hole (unauthorized read of private objects + unauthorized upload-URL minting). A code review will flag it as serious. The commented-out ACL block is easy to overlook because the code "looks done".

**How to apply:** any app using this scaffold must re-gate these two routes. For true per-tenant ownership you must also set/check an ACL policy at association time; at minimum require authentication so private object keys aren't world-readable.
