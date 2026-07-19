---
name: Invite-accept provisioning race
description: Why invited team members could end up owning a shadow personal tenant, and the guard that prevents it.
---

A SPA's first load fires several authenticated requests in parallel. In tenant provisioning, one request can accept a pending team invite (membership insert + invite marked accepted) while a sibling request, having already missed the membership check and now finding no *pending* invite, falls through and provisions a personal tenant. Owner-tenant lookup runs before membership lookup, so the shadow personal tenant permanently wins and the user never appears as a member.

**Why:** observed live during e2e (member saw owner-only nav despite an accepted invite and a valid membership row).

**How to apply:** in `requireTenant`, re-check `tenant_members` immediately before inserting a personal tenant. Any future auth/provisioning path must assume first requests are concurrent, not sequential.

Same race affects side effects: multiple concurrent requests can all pass the onConflictDoNothing membership insert, so the "member joined" notification must be gated on the atomic invite flip (`UPDATE ... WHERE status='pending' RETURNING`) — only the request that wins the flip notifies.
