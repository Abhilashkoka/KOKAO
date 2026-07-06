---
name: Superadmin allowlist source
description: Where the cross-tenant superadmin allowlist comes from and how to keep tests working.
---

# Superadmin allowlist source

The cross-tenant superadmin email allowlist is built EXCLUSIVELY from the
`SUPERADMIN_EMAILS` env var (comma-separated), captured ONCE at module load in
`lib/superadmins.ts`. There are NO hardcoded admin emails in source.

**Why:** hardcoding an owner email leaks a real person's address into the code
export and makes ownership a code change. Env-only config keeps admins as
deployment configuration; an unset var means zero allowlisted admins (fail-safe).

**How to apply:**
- Because the allowlist is captured at MODULE LOAD, setting `SUPERADMIN_EMAILS`
  inside a test body is too late. Tests set it via vitest `setupFiles`
  (`src/test-setup.ts`) which runs before app modules import. If you add a test
  that needs an owner, rely on that setup, don't set the env in `beforeEach`.
- Effective superadmin = live-verified Clerk email in the allowlist OR the
  grantable `tenants.isSuperadmin` DB flag. The cached `tenants.email` column is
  a UI hint only, never the auth boundary.
- Owner accounts (allowlisted emails) are permanent; grant/revoke is owner-only.
