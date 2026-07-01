import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const connectedAccountsTable = pgTable("connected_accounts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  platform: text("platform").notNull(),
  accountName: text("account_name").notNull(),
  status: text("status").notNull().default("connected"),
  accessToken: text("access_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  providerUserId: text("provider_user_id"),
  // Manually-entered per-tenant credentials (Facebook Page token/ID, Instagram
  // Business account ID, etc.), stored as an AES-256-GCM encrypted JSON blob.
  encryptedCredentials: text("encrypted_credentials"),
  // Result of the most recent automatic validity test against the live platform.
  verifyStatus: text("verify_status"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifyError: text("verify_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertConnectedAccountSchema = createInsertSchema(connectedAccountsTable).omit({
  id: true,
  tenantId: true,
  createdAt: true,
});
export type InsertConnectedAccount = z.infer<typeof insertConnectedAccountSchema>;
export type ConnectedAccount = typeof connectedAccountsTable.$inferSelect;
