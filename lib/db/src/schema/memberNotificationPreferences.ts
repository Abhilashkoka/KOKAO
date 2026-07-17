import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-MEMBER notification channel preferences, one row per (workspace, member,
 * type). The tenant-scoped notification_preferences table is the workspace
 * owner's choice; team members (admin/member roles) working inside someone
 * else's workspace get their own rows here so an individual admin can, e.g.,
 * turn off team-departure emails for themselves without affecting the owner or
 * other admins. A missing row means "use the defaults" (in-app on, email on),
 * matching the tenant-scoped opt-out model. Global policy still bounds what
 * actually fires: "forced"/"off" email policies override the stored value at
 * resolution time.
 */
export const memberNotificationPreferencesTable = pgTable(
  "member_notification_preferences",
  {
    id: serial("id").primaryKey(),
    // The WORKSPACE the member belongs to (tenants.id of the owner's tenant).
    tenantId: integer("tenant_id").notNull(),
    // The member's own Clerk user id — the per-person scope key.
    clerkUserId: text("clerk_user_id").notNull(),
    // Machine-readable notification category, e.g. "team_member_left".
    type: text("type").notNull(),
    // Show an in-app popup/banner for this type.
    inApp: boolean("in_app").notNull().default(true),
    // Also send an email to this member for this type (when policy allows).
    email: boolean("email").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    memberTypeUnique: uniqueIndex("member_notif_pref_tenant_user_type_uq").on(
      t.tenantId,
      t.clerkUserId,
      t.type,
    ),
  }),
);

export type MemberNotificationPreference =
  typeof memberNotificationPreferencesTable.$inferSelect;
