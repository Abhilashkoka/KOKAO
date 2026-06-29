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
