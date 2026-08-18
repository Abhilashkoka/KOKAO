import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

/**
 * In-app help & support requests (complaints, questions, bug reports).
 * Submitted by any signed-in workspace user from the Help page; reviewed and
 * resolved by platform admins (superadmins) from the admin dashboard.
 */
export const supportRequestsTable = pgTable("support_requests", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  // Who filed it (cached for display; the tenant row's email can change).
  submitterEmail: text("submitter_email"),
  // complaint | question | bug | billing | other
  category: text("category").notNull().default("other"),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"), // open | resolved
  // Optional reply written by the admin when resolving; shown to the user.
  adminReply: text("admin_reply"),
  resolvedByEmail: text("resolved_by_email"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SupportRequest = typeof supportRequestsTable.$inferSelect;
