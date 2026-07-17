import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) speech-to-text (ASR) configuration, stored as a
 * single row (id = 1). Managed by superadmins only.
 *
 * `provider` selects which transcription backend `/ai/transcribe` uses.
 * Valid values live in the ASR provider catalog on the api-server
 * (artifacts/api-server/src/lib/asr). The row is optional: when absent the
 * server falls back to the default provider ("groq").
 */
export const asrSettingsTable = pgTable("asr_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("groq"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AsrSettings = typeof asrSettingsTable.$inferSelect;
