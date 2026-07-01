import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Global (platform-wide) notification policy set by superadmins, one row per
 * notification type. A missing row means the built-in defaults apply
 * (enabled, email policy "optional"). This is the admin-side control layer:
 * it can disable a whole notification type for everyone, or govern how the
 * email channel is offered to tenants.
 *
 * emailPolicy values:
 *  - "optional": each tenant decides whether email is on (default).
 *  - "forced":   email is always sent (tenants cannot turn it off).
 *  - "off":      email is never sent (tenants cannot turn it on).
 */
export const notificationPoliciesTable = pgTable("notification_policies", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  emailPolicy: text("email_policy").notNull().default("optional"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type NotificationPolicy = typeof notificationPoliciesTable.$inferSelect;
