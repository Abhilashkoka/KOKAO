---
name: Admin audit trail
description: How privileged superadmin actions are logged for accountability in SocialForge.
---

# Admin audit trail

Privileged cross-tenant superadmin actions are recorded in an append-only table
so multi-superadmin abuse/mistakes are traceable.

- Table `admin_audit_logs` (`lib/db/src/schema/adminAuditLogs.ts`): action,
  actor tenant/email, target tenant/email, oldValue, newValue, createdAt.
  Routes only INSERT — never update/delete.
- Helper `recordAdminAction` (`artifacts/api-server/src/lib/adminAudit.ts`).
- Wired into `routes/admin.ts`: plan override + superadmin grant/revoke, and
  read via `GET /admin/audit-logs` (superadmin-gated, 100 most recent).

**Why best-effort:** the audit insert is wrapped in try/catch AFTER the primary
mutation succeeds, so a logging failure must never make a legitimate privileged
action look like it failed.

**How to apply:** when adding a new privileged admin mutation (e.g. notification
policy changes, credential saves), reuse `recordAdminAction` and only log on an
actual value change (compare prior vs updated), the same pattern the plan/role
handlers use. Actor email should prefer the LIVE verified email when the handler
already resolved one (superadmin route) over the cached `req.tenantEmail`.
