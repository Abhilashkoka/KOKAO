import { pgTable, text, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";

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
  /**
   * Which catalog models tenants may pick per generation
   * (lib/videoGen/modelCatalog.ts on the api-server).
   *
   * NULL means "every catalog model", which is what an untouched deployment
   * gets — the point of the catalog is that a tenant can choose. An admin
   * narrows the list when a model misbehaves, gets expensive, or belongs to a
   * provider whose key they have not saved. An empty array means "no
   * per-generation choice at all": every job runs on the platform selection
   * above, exactly as it did before the catalog existed.
   */
  enabledModelIds: jsonb("enabled_model_ids").$type<string[] | null>(),
  /**
   * Replicate model for PORTRAIT lip sync ("owner/name", or
   * "owner/name:version" for a community model), which turns one headshot
   * plus audio into a talking video.
   *
   * NULL = portrait mode is off, and preflight says so with instructions.
   * There is no default because pinning a guessed slug and version hash would
   * 404 on the first paid job; video-mode lip sync (LatentSync) is pinned in
   * source and needs nothing here.
   */
  lipSyncPortraitModel: text("lip_sync_portrait_model"),
  /** Default offered for the optional, cross-Studio finishing pass. */
  studioLipSyncDefault: boolean("studio_lip_sync_default").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VideoGenSettings = typeof videoGenSettingsTable.$inferSelect;
