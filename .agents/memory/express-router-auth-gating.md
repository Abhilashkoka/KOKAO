---
name: Express router auth gating
description: Why per-router requireTenant/auth middleware leaks across routers, and the correct gating pattern.
---

When you mount several sub-routers on a parent with `parent.use(subRouter)` (no path), each sub-router is mounted at `/`. If a sub-router calls `router.use(requireAuth)` with no path, that middleware runs for EVERY request that reaches that sub-router — not just the routes defined in it — because the mount path is `/`. A request for a path handled by a *later* router still passes through the earlier routers' middleware first, so a public endpoint mounted after an auth-gated router gets 401'd.

**Symptom:** a public endpoint (e.g. `/api/plans`) returns 401 Unauthorized even though its own router has no auth middleware.

**Rule:** gate auth ONCE in the central router file. Mount public routers first, then `router.use(requireAuth)`, then the protected routers. Remove per-router `router.use(requireAuth)` from the protected route files.

**Why:** Express composes middleware in mount order across all routers sharing the `/` prefix; per-router gating both leaks onto unrelated routes and double-runs (extra DB queries) for routes that legitimately need it.
