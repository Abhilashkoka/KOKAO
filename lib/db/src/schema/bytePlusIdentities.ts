import { pgTable, text, serial, integer, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A tenant-scoped real person verified by BytePlus before portrait use. */
export const bytePlusIdentitiesTable = pgTable("byteplus_identities", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  label: text("label").notNull(),
  verificationTokenHash: text("verification_token_hash"),
  assetGroupId: text("asset_group_id"),
  status: text("status").$type<"pending" | "completing" | "verified" | "failed">()
    .notNull().default("pending"),
  resultCode: text("result_code"),
  error: text("error"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("byteplus_identities_tenant_label_uniq").on(table.tenantId, table.label),
  check("byteplus_identities_status_check",
    sql`${table.status} in ('pending', 'completing', 'verified', 'failed')`),
]);

export type BytePlusIdentity = typeof bytePlusIdentitiesTable.$inferSelect;