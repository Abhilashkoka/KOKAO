import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Append-only audit trail of privileged cross-tenant admin actions: a
 * superadmin overriding a tenant's subscription plan, or granting/revoking the
 * superadmin role. These routes only ever INSERT here (never update or delete),
 * so the log is a permanent record for accountability and incident
 * investigation when multiple superadmins exist.
 *
 * action values:
 *  - "plan_change":        a tenant's plan was overridden.
 *  - "superadmin_grant":   the in-app superadmin role was granted.
 *  - "superadmin_revoke":  the in-app superadmin role was revoked.
 *  - "plan_edit":          a subscription plan's limits/pricing were edited
 *                          (platform-wide; no target tenant).
 */
export const adminAuditLogsTable = pgTable("admin_audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actorTenantId: integer("actor_tenant_id").notNull(),
  actorEmail: text("actor_email"),
  // Nullable: platform-wide actions (e.g. plan_edit) have no target tenant.
  targetTenantId: integer("target_tenant_id"),
  targetEmail: text("target_email"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAdminAuditLogSchema = createInsertSchema(
  adminAuditLogsTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertAdminAuditLog = z.infer<typeof insertAdminAuditLogSchema>;
export type AdminAuditLog = typeof adminAuditLogsTable.$inferSelect;
