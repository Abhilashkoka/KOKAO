import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) video generation configuration, stored as a
 * single row (id = 1). Managed by superadmins only — the exact same pattern
 * as image_gen_settings.
 *
 * `provider` selects which backend the AI video engines use. Valid values
 * live in the video-gen provider catalog on the api-server
 * (artifacts/api-server/src/lib/videoGen). The row is optional: when absent
 * the server falls back to the default provider (Replicate).
 *
 * `textToVideoModel` / `imageToVideoModel` optionally override the
 * provider's default model per engine (video models are usually distinct
 * for text-to-video vs image-to-video, unlike image gen's single model).
 */
export const videoGenSettingsTable = pgTable("video_gen_settings", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("replicate"),
  textToVideoModel: text("text_to_video_model"),
  imageToVideoModel: text("image_to_video_model"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VideoGenSettings = typeof videoGenSettingsTable.$inferSelect;
