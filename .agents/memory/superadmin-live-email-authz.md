---
name: Superadmin authz via live verified email
description: Why cross-tenant superadmin must be gated on the live verified Clerk email, not a cached DB column.
---

# Superadmin authorization: live verified email, not cached column

Cross-tenant superadmin is designated by an email allowlist. The authoritative
gate re-resolves the user's CURRENT verified primary email from Clerk and checks
the allowlist live. A cached `tenants.email` column is used only as a UI hint
(exposed via /me to toggle the nav link) and for display — never as the security
boundary.

**Why:** Deriving privilege from a cached DB email causes authorization drift —
if a Clerk email changes off the allowlist, a stale cache would keep granting
access (revocation lag), and an unverified address must never confer privilege.
Tying the gate to the live verified identity makes revocation immediate and
fail-closed.

**How to apply:**
- Only trust an email whose Clerk `verification.status === "verified"` for any
  authz decision (see the shared verified-email helper).
- Do the live Clerk lookup in the privileged gate middleware only (admin routes
  are low-traffic). Do NOT fetch the Clerk user on every authenticated request —
  that adds latency/rate-limit pressure to all endpoints.
- The gate fails closed: any Clerk error → deny (403).
- Opportunistically self-heal the cached email inside the gate so the UI hint and
  admin table stay accurate.

## Superadmin is also a grantable per-tenant role

Superadmin = a permanent allowlist (email) PLUS a grantable per-tenant DB flag
(`tenants.isSuperadmin`). Effective access = DB flag OR allowlisted email.

- The /admin gate trusts the DB flag as a fast-path (loaded fresh per request),
  otherwise falls back to the live verified-email allowlist check above. Revoking
  the DB flag takes effect immediately because it is read fresh each request.
- **Role management (grant/revoke) is OWNER-ONLY**: the endpoint that toggles the
  flag must independently verify the ACTOR is allowlisted via their LIVE verified
  email — a merely granted superadmin must NOT be able to mint/remove other
  superadmins. Reject writes whose TARGET is allowlisted (owners are permanent;
  also prevents self-lockout).
- **Why:** a DB-granted superadmin passing the /admin gate does not imply they may
  manage roles; that is a strictly higher privilege reserved for root owners.
- Frontend: the admin page must treat a 403 from any admin endpoint as
  authoritative "access denied" — do NOT gate only on the cached `me.isSuperadmin`
  (React Query serves it stale after a live revoke). Expose an `isOwner` hint on
  /me to disable role-management controls for non-owner superadmins.
