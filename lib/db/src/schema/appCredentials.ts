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

/**
 * OAuth 2.0 client credentials for X (Twitter). These are the "OAuth 2.0 Client
 * ID and Client Secret" from the X developer portal (a confidential client),
 * NOT the legacy OAuth 1.0a consumer API Key/Secret. They drive the PKCE
 * authorization-code flow tenants use to connect their account.
 */
export const twitterAppCredentialsSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});
export type TwitterAppCredentials = z.infer<typeof twitterAppCredentialsSchema>;

/**
 * OAuth 2.0 client credentials for LinkedIn (from the app's Auth tab in the
 * LinkedIn developer portal). They drive the authorization-code flow tenants
 * use to connect their LinkedIn account. Stored encrypted; the
 * LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET env vars remain a fallback.
 */
export const linkedinAppCredentialsSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});
export type LinkedinAppCredentials = z.infer<typeof linkedinAppCredentialsSchema>;

/**
 * Google OAuth 2.0 client credentials used for the YouTube connect flow (from
 * a Google Cloud project's "OAuth client ID" of type Web application). They
 * drive the authorization-code flow tenants use to connect their YouTube
 * channel. Stored encrypted; GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env vars
 * remain a fallback.
 */
export const youtubeAppCredentialsSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});
export type YoutubeAppCredentials = z.infer<typeof youtubeAppCredentialsSchema>;

/**
 * Threads (by Meta) OAuth 2.0 app credentials — the "Threads App ID" and
 * "Threads App Secret" from a Meta app with the "Access the Threads API" use
 * case. NOTE: these are distinct from the regular Facebook App ID/Secret, even
 * within the same Meta app. They drive the authorization-code flow tenants use
 * to connect their Threads profile. Stored encrypted.
 */
export const threadsAppCredentialsSchema = z.object({
  appId: z.string(),
  appSecret: z.string(),
});
export type ThreadsAppCredentials = z.infer<typeof threadsAppCredentialsSchema>;

/**
 * Razorpay API credentials (Key ID + Key Secret from the Razorpay dashboard)
 * plus the webhook signing secret configured for the webhook endpoint. They
 * drive subscription billing and one-time credit-pack payments. Superadmin
 * managed, stored encrypted; no env fallback.
 */
export const razorpayAppCredentialsSchema = z.object({
  keyId: z.string(),
  keySecret: z.string(),
  webhookSecret: z.string(),
});
export type RazorpayAppCredentials = z.infer<typeof razorpayAppCredentialsSchema>;
