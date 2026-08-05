import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Admin-added OpenAI-compatible AI providers (superadmin only).
 *
 * A row here makes the provider selectable in the existing per-use-case
 * settings (text/captions, image generation, video generation) under the
 * provider id "custom:<id>" — no code change or deploy needed to onboard a
 * new vendor, as long as it speaks the OpenAI-compatible API surface:
 *   - text/captions: POST {baseUrl}/chat/completions
 *   - image:         POST {baseUrl}/images/generations
 *   - video:         OpenRouter-shaped async API (POST {baseUrl}/videos,
 *                    poll GET {baseUrl}/videos/{id}, download unsigned_urls)
 *
 * The per-use-case toggles gate WHERE the provider may be selected; models
 * are entered in each use case's own settings card (exactly like the
 * built-in providers), and pricing goes through the same activation gate —
 * unknown models need a manual price row before they can be activated.
 *
 * The API key is encrypted at rest (secretCrypto) and nullable: self-hosted
 * endpoints may be keyless.
 */
export const customAiProvidersTable = pgTable("custom_ai_providers", {
  id: serial("id").primaryKey(),
  /** Label shown in every provider dropdown. */
  name: text("name").notNull(),
  /** OpenAI-compatible API root, e.g. https://api.together.xyz/v1 (https only). */
  baseUrl: text("base_url").notNull(),
  /** encryptJson({ apiKey }) — null for keyless endpoints. */
  encryptedApiKey: text("encrypted_api_key"),
  textEnabled: boolean("text_enabled").notNull().default(false),
  imageEnabled: boolean("image_enabled").notNull().default(false),
  videoEnabled: boolean("video_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CustomAiProvider = typeof customAiProvidersTable.$inferSelect;
