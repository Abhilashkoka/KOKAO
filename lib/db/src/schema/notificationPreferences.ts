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
 * Per-tenant notification channel preferences, one row per notification type.
 * A missing row means "use the defaults" (in-app on, email off). What a tenant
 * is actually allowed to change is bounded by the global policy
 * (notification_policies): e.g. when a type's email policy is "forced" or "off"
 * the stored `email` value is ignored at resolution time.
 */
export const notificationPreferencesTable = pgTable(
  "notification_preferences",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    // Machine-readable notification category, e.g. "social_connection_failed".
    type: text("type").notNull(),
    // Show an in-app popup/banner for this type.
    inApp: boolean("in_app").notNull().default(true),
    // Also send an email for this type (only when policy allows it).
    email: boolean("email").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantTypeUnique: uniqueIndex("notif_pref_tenant_type_uq").on(
      t.tenantId,
      t.type,
    ),
  }),
);

export type NotificationPreference =
  typeof notificationPreferencesTable.$inferSelect;
