import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) image generation configuration, stored as a
 * single row (id = 1). Managed by superadmins only.
 *
 * `provider` selects which backend /ai/generate-image uses. Valid values live
 * in the image-gen provider catalog on the api-server
 * (artifacts/api-server/src/lib/imageGen). The row is optional: when absent
 * the server falls back to the built-in OpenAI integration.
 *
 * `model` optionally overrides the provider's default model name.
 * `customBaseUrl` is only used by the "custom" (OpenAI-compatible) provider.
 */
export const imageGenSettingsTable = pgTable("image_gen_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("openai"),
  model: text("model"),
  customBaseUrl: text("custom_base_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ImageGenSettings = typeof imageGenSettingsTable.$inferSelect;
