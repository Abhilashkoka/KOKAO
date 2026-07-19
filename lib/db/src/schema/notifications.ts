import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const notificationsTable = pgTable(
  "notifications",
  {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  // Machine-readable category, e.g. "social_connection_failed".
  type: text("type").notNull(),
  // Optional platform this notification is about (facebook/instagram/linkedin).
  platform: text("platform"),
  // Optional id of the domain row this notification is about (e.g. the seat
  // request id for seat_request_submitted), so resolvers can target exactly
  // the alerts belonging to one decided/handled item.
  referenceId: integer("reference_id"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  // Relative in-app link the notification points to (e.g. "/accounts").
  linkUrl: text("link_url"),
  // Whether this notification should surface as an in-app popup/banner. When a
  // tenant has turned off the in-app channel for this type, the row is still
  // recorded (for dedupe/audit and any email side channel) but hidden from the
  // banner by the notifications list query.
  inApp: boolean("in_app").notNull().default(true),
  // When the user dismissed/acknowledged this notification. Null = unread.
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  (t) => ({
    // Race-free dedupe for the sweep-stalled admin alert: at most ONE unread
    // sweep_stalled row per tenant, enforced by the database so concurrent
    // watchdog checks can't double-insert. Scoped to that single type — other
    // notification types allow multiple unread rows.
    sweepStalledUnreadUnique: uniqueIndex("notifications_sweep_stalled_unread_uq")
      .on(t.tenantId)
      .where(sql`${t.type} = 'sweep_stalled' AND ${t.readAt} IS NULL`),
  }),
);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
