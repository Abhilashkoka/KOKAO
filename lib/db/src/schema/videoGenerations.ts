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
 * status: queued | processing | awaiting_review | succeeded | failed
 * engine: text_to_video | image_to_video | slideshow | topic_to_video
 *
 * awaiting_review is the storyboard pause: the job planned its scenes, voiced
 * the narration and generated a preview still per scene, then stopped before
 * the expensive half so the user can edit the plan. Approving resumes it.
 */

/** Options captured at enqueue time so the job is fully self-describing. */
export interface VideoJobOptions {
  /** Output aspect ratio; drives the encode/prediction resolution. */
  aspectRatio: "16:9" | "9:16" | "1:1";
  /** AI engines: requested clip length in seconds. */
  durationSec?: number;
  /** text_to_video: how many shots the storyboard splits the brief into. Each
   * shot is its own AI generation, so this is also the job's unit cost — it is
   * fixed at enqueue time (the reservation is made from it) and the storyboard
   * editor cannot add or remove shots afterwards. */
  shotCount?: number;
  /** Slideshow: seconds each photo is on screen. */
  slideDurationSec?: number;
  /** Slideshow: optional caption burned into the video. */
  overlayText?: string | null;
  /** Slideshow + topic_to_video: optional /objects/... path of a music track. */
  musicPath?: string | null;
  /** Slideshow + topic_to_video: AI-composed music bed description (used
   * only when musicPath is null; costs one extra video unit). */
  musicPrompt?: string | null;
  /** topic_to_video: narration voice. */
  voice?: string;
  /** topic_to_video: stock footage source ("auto" | "pexels" | "pixabay" | "wikimedia"). */
  stockSource?: string;
  /** topic_to_video: burn per-sentence subtitles (default true). */
  subtitles?: boolean;
  /** topic_to_video: "classic" sentence subtitles or "dynamic" word groups. */
  captionStyle?: string;
  /** topic_to_video: script length in paragraphs (~30s each, 1-3). */
  paragraphCount?: number;
  /** topic_to_video: "stock" footage (default) or AI "character" scenes. */
  visualsSource?: string;
  /** Character lock: the tenant character featured in the video. */
  characterId?: number | null;
  /** Costume lock: the outfit the character wears (default outfit if null). */
  outfitId?: number | null;
  /** topic_to_video character mode: costume-change instructions. */
  wardrobeNotes?: string | null;
  /** topic_to_video: brand kit steering voice, caption accent, watermark. */
  brandKitId?: number | null;
  /** topic_to_video: reference-derived style profile steering pacing + hook. */
  styleProfileId?: number | null;
  /** Pause after planning so the user can edit the storyboard before the
   * expensive half runs. Honoured by every engine except topic_to_video's stock
   * branch, whose visuals are searched rather than prompted. */
  reviewStoryboard?: boolean;
  /** Scenes added to the storyboard during review, each funded as one extra
   * unit at insert time. Lives in options so every path that recomputes the
   * job's price from engine+options (usage metering on success, refunds on
   * failure/discard/sweep) stays consistent without knowing about inserts. */
  addedScenes?: number;
}

/** One reviewable beat of a video: the narration it covers, the prompt that
 * will generate it, and a preview still of what that prompt produced. */
export interface VideoStoryboardScene {
  /** Stable address for edits ("s1", "s2", ...); never reused or renumbered. */
  id: string;
  /** The narration this scene plays under. Editable on narrated (topic)
   * plans: the voiceover is re-recorded to match on approve, and scene lengths
   * follow the new recording. Empty on engines that voice no script. */
  text: string;
  /** What this beat shows. The field the user edits — a generation prompt on
   * every engine except "slide", where it is the caption burned over the photo
   * (empty for no caption). */
  visual: string;
  /** Seconds on screen. Read-only while timelineLocked; otherwise clamped to
   * the plan's durationBounds. */
  durationSec: number;
  /** /objects/... preview still, or null when the preview failed to generate
   * (the scene still renders; only its thumbnail is missing). On "photo" and
   * "slide" plans this is the user's own uploaded photo. */
  previewPath: string | null;
  /** Character mode: the outfit worn in this scene. */
  outfitId: number | null;
}

/** How a plan's scenes get rendered, and therefore what is editable on them:
 *
 * - `character` — topic mode: a generated keyframe per scene, animated.
 * - `ai`        — topic mode: a generated still per scene, Ken Burns encoded.
 * - `prompt`    — text_to_video: one AI clip per shot, concatenated. No preview
 *                 still exists, because nothing image-shaped is generated.
 * - `photo`     — image_to_video: the user's own photo animated. The preview is
 *                 that photo, so it costs nothing and cannot be re-rolled.
 * - `slide`     — slideshow: the user's photos, no AI at all. `visual` is the
 *                 per-slide caption.
 *
 * Only `character` and `ai` have re-rollable previews; the rest either have no
 * still or use one the user supplied.
 */
export type VideoStoryboardSource = "character" | "ai" | "prompt" | "photo" | "slide";

/** True when this plan's previews are generated (and so can be re-rolled). */
export function storyboardPreviewsAreGenerated(source: VideoStoryboardSource): boolean {
  return source === "character" || source === "ai";
}

/** The plan a paused job is waiting on. Stored on the job row so approving is
 * a resume rather than a re-plan, and so a client only needs the job GET. */
export interface VideoStoryboard {
  version: 1;
  /** Which pipeline will render these scenes; see VideoStoryboardSource. */
  visualsSource: VideoStoryboardSource;
  /** True when scene lengths are dictated by already-voiced narration, which
   * makes durationSec read-only — editing one would either desync every later
   * scene from the audio or silently change the total length. */
  timelineLocked: boolean;
  /** Per-scene length limits, enforced on edit and at render. Null when the
   * timeline is locked (there is nothing to bound) and on plans written before
   * unlocked timelines existed. */
  durationBounds?: { minSec: number; maxSec: number } | null;
  model: string | null;
  provider: string | null;
  /** Preview regenerations spent so far; capped server-side. */
  regenerations: number;
  /** The voiced narration the scenes are cut against, parked in tenant storage
   * so approving does not have to re-synthesize (and re-bill) it. Null on the
   * engines that voice no script. */
  narration: {
    audioPath: string;
    totalDurationSec: number;
    cues: { text: string; startSec: number; endSec: number }[];
  } | null;
  scenes: VideoStoryboardScene[];
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
  /** What the pipeline is doing right now ("Writing the script", ...); only
   * meaningful while status is processing. Shown live in the studio. */
  stage: text("stage"),
  /** Wall-clock generation time, for the usage/cost meters. */
  durationMs: integer("duration_ms"),
  /** How the route paid for this job, so a sweep that settles an abandoned
   * one knows whether there are credits to give back. */
  funding: text("funding").$type<"quota" | "credit">(),
  /** The editable plan; only set while status is awaiting_review (and kept
   * afterwards as a record of what was approved). */
  storyboard: jsonb("storyboard").$type<VideoStoryboard>(),
  /** When an unreviewed storyboard is swept and the reservation refunded.
   * Null unless the job is awaiting_review. */
  storyboardExpiresAt: timestamp("storyboard_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VideoGeneration = typeof videoGenerationsTable.$inferSelect;
