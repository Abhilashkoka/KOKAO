import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * One row per video generation job. Video generation is long-running (AI
 * providers can take minutes; the slideshow encoder is CPU-bound), so the
 * request only creates this row and the work runs as an in-process background
 * job (lib/backgroundJobs.ts) that persists its own progress here. Clients
 * poll GET /ai/video-jobs/{id} until status is succeeded or failed.
 *
 * status: queued | processing | succeeded | failed
 * engine: text_to_video | image_to_video | slideshow
 */

/** Options captured at enqueue time so the job is fully self-describing. */
export interface VideoJobOptions {
  /** Output aspect ratio; drives the encode/prediction resolution. */
  aspectRatio: "16:9" | "9:16" | "1:1";
  /** AI engines: requested clip length in seconds. */
  durationSec?: number;
  /** Slideshow: seconds each photo is on screen. */
  slideDurationSec?: number;
  /** Slideshow: optional caption burned into the video. */
  overlayText?: string | null;
  /** Slideshow: optional /objects/... path of a background music track. */
  musicPath?: string | null;
}

export const videoGenerationsTable = pgTable("video_generations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  engine: text("engine").notNull(),
  status: text("status").notNull().default("queued"),
  /** The user's brief (text_to_video / image_to_video motion hint). */
  prompt: text("prompt"),
  /** Ordered /objects/... source images (image_to_video uses the first). */
  sourceImagePaths: jsonb("source_image_paths").$type<string[]>(),
  options: jsonb("options").$type<VideoJobOptions>(),
  /** Provider/model that produced the video (null for the slideshow engine). */
  provider: text("provider"),
  model: text("model"),
  /** Set on success: /objects/<tenantId>/uploads/<uuid> of the mp4. */
  videoPath: text("video_path"),
  /** Set on success: poster frame PNG for library grids and previews. */
  thumbnailPath: text("thumbnail_path"),
  /** Human-readable failure reason; null unless status is failed. */
  error: text("error"),
  /** Wall-clock generation time, for the usage/cost meters. */
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VideoGeneration = typeof videoGenerationsTable.$inferSelect;
