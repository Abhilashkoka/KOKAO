import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  // Machine-readable category, e.g. "social_connection_failed".
  type: text("type").notNull(),
  // Optional platform this notification is about (facebook/instagram/linkedin).
  platform: text("platform"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  // Relative in-app link the notification points to (e.g. "/accounts").
  linkUrl: text("link_url"),
  // When the user dismissed/acknowledged this notification. Null = unread.
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
