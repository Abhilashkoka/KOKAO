import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) email delivery settings. Single row, managed by
 * superadmins only.
 *
 * `sendingEnabled` is the global pause switch: when false, no transactional
 * email is sent regardless of credentials (in-app notifications still record).
 *
 * Credentials are optional overrides: when `encryptedApiKey` (+ `fromEmail`)
 * are present they take precedence over the Replit-managed SendGrid connector,
 * letting an admin enter a SendGrid API key + verified sender directly. The API
 * key is stored AES-256-GCM encrypted; `fromEmail` is not a secret.
 */
export const emailSettingsTable = pgTable("email_settings", {
  id: serial("id").primaryKey(),
  sendingEnabled: boolean("sending_enabled").notNull().default(true),
  fromEmail: text("from_email"),
  encryptedApiKey: text("encrypted_api_key"),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestError: text("last_test_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type EmailSettings = typeof emailSettingsTable.$inferSelect;
