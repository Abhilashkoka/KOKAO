import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) text generation routing, stored as a single row
 * (id = 1). Managed by superadmins only.
 *
 * `provider` selects which backend serves caption/topic/campaign text:
 *   - "builtin"    — the built-in OpenAI integration (default; today's behavior)
 *   - "openrouter" — OpenRouter with the admin's own API key
 *
 * The row is optional: when absent the server behaves exactly as before
 * (built-in OpenAI). Switching back to "builtin" is the rollback path.
 *
 * `models` is the admin-curated list of OpenRouter model ids tenants may pick
 * from; `defaultModel` is used for tenants whose saved model is not in the
 * list (must itself be one of `models`).
 */
export const textGenSettingsTable = pgTable("text_gen_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("builtin"),
  models: jsonb("models").$type<string[]>().notNull().default([]),
  defaultModel: text("default_model"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TextGenSettings = typeof textGenSettingsTable.$inferSelect;
