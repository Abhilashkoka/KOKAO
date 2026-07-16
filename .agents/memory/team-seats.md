---
name: Team seats add-on
description: How team members / seat limits work and the member-context pitfall in privileged middleware.
---

- Effective seat limit = `tenants.seatLimit` (per-workspace override, written by approved seat requests) ?? plan `teamSeats` (0 = add-on off). Seats used = 1 (owner) + active members + pending invites — a pending invite already holds a seat, so invite auto-accept checks `used <= limit`, not `<`.
- Invite acceptance happens inside `requireTenant` on first authenticated request with a verified matching email; members get `isSuperadmin`/`tenantIsSuperadmin = false` and `req.memberRole` set.
- **Pitfall:** once members exist, `req.tenantId`/`req.tenantEmail` may describe SOMEONE ELSE'S workspace. Any middleware or route that writes owner-identity columns (e.g. the superadmin email self-heal) must gate on `req.memberRole === "owner"` AND `tenants.clerkUserId = req.clerkUserId`, or an allowlisted member browsing another workspace corrupts that workspace's owner email.
- **Why:** architect review caught exactly this cross-identity overwrite in `requireSuperadmin`; regression test lives in `requireSuperadmin.test.ts`.
- **How to apply:** when adding any tenant-column write triggered by the current user, ask "could the actor be a member, not the owner?" and scope by clerkUserId.
