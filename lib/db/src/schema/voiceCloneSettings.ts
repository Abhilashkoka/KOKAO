import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) voice-cloning / brand-voice TTS configuration,
 * stored as a single row (id = 1). Managed by superadmins only.
 *
 * `provider` selects which cloud voice-cloning backend the Brand Voice
 * feature uses (clone creation, previews, and brand-voice narration). Valid
 * values live in the voice-clone provider catalog on the api-server
 * (artifacts/api-server/src/lib/voiceClone). The row is optional: when absent
 * the server falls back to the default provider ("elevenlabs").
 */
export const voiceCloneSettingsTable = pgTable("voice_clone_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("elevenlabs"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VoiceCloneSettings = typeof voiceCloneSettingsTable.$inferSelect;
