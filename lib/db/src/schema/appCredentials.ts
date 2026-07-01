import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

/**
 * App-level (platform-wide) API credentials, one row per provider group.
 * e.g. provider "meta" holds the Meta App ID + App Secret used by every tenant
 * to publish to Facebook and Instagram. Managed by superadmins only.
 *
 * `encryptedCredentials` holds an AES-256-GCM encrypted JSON blob; secrets are
 * never stored in plaintext and never returned to the client in full.
 */
export const appCredentialsTable = pgTable("app_credentials", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().unique(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestError: text("last_test_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AppCredential = typeof appCredentialsTable.$inferSelect;

export const metaAppCredentialsSchema = z.object({
  appId: z.string(),
  appSecret: z.string(),
});
export type MetaAppCredentials = z.infer<typeof metaAppCredentialsSchema>;

export const twitterAppCredentialsSchema = z.object({
  apiKey: z.string(),
  apiSecret: z.string(),
});
export type TwitterAppCredentials = z.infer<typeof twitterAppCredentialsSchema>;
