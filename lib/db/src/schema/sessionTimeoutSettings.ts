import { boolean, integer, pgTable, serial, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton app-level settings for the web app's inactivity auto-logout.
 * Superadmin-editable; readable by any signed-in user.
 */
export const sessionTimeoutSettingsTable = pgTable("session_timeout_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  /** Minutes of inactivity before the user is signed out. */
  timeoutMinutes: integer("timeout_minutes").notNull().default(30),
  /** Seconds before logout at which the warning countdown dialog appears. */
  warningSeconds: integer("warning_seconds").notNull().default(60),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SessionTimeoutSettings =
  typeof sessionTimeoutSettingsTable.$inferSelect;
