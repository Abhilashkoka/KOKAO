import { pgTable, text, serial, integer, timestamp, uniqueIndex, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A tenant-scoped real person verified by BytePlus before portrait use. */
export const bytePlusIdentitiesTable = pgTable("byteplus_identities", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  label: text("label").notNull(),
  verificationAttemptId: text("verification_attempt_id"),
  verificationTokenHash: text("verification_token_hash"),
  verificationTokenEncrypted: text("verification_token_encrypted"),
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

/** Durable provider cleanup outbox. The provider id is never returned to tenant or admin clients. */
export const bytePlusIdentityCleanupsTable = pgTable("byteplus_identity_cleanups", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  sourceIdentityId: integer("source_identity_id").notNull(),
  sourceAttemptId: text("source_attempt_id").notNull(),
  assetGroupId: text("asset_group_id"),
  verificationTokenEncrypted: text("verification_token_encrypted"),
  status: text("status").$type<"pending" | "processing" | "succeeded" | "unsupported" | "exhausted">()
    .notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: text("lease_token"),
  lastErrorCode: text("last_error_code"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("byteplus_identity_cleanups_source_attempt_uniq").on(table.sourceAttemptId),
  uniqueIndex("byteplus_identity_cleanups_asset_group_uniq")
    .on(table.assetGroupId)
    .where(sql`${table.assetGroupId} is not null`),
  index("byteplus_identity_cleanups_due_idx").on(table.status, table.nextAttemptAt),
  check("byteplus_identity_cleanups_status_check",
    sql`${table.status} in ('pending', 'processing', 'succeeded', 'unsupported', 'exhausted')`),
  check("byteplus_identity_cleanups_attempts_check", sql`${table.attempts} >= 0`),
]);

export type BytePlusIdentityCleanup = typeof bytePlusIdentityCleanupsTable.$inferSelect;