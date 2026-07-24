import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * One row per background image generation job. Image providers can be slow
 * (tens of seconds), so the async flow only creates this row and the work
 * runs as an in-process background job (lib/backgroundJobs.ts) that persists
 * its own progress here. Clients poll GET /ai/image-jobs/{id} until status is
 * succeeded or failed. Funding is reserved by the route BEFORE enqueueing and
 * settled/refunded by the runner, exactly like video jobs.
 *
 * status: queued | processing | succeeded | failed
 */
export const imageGenerationsTable = pgTable("image_generations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  status: text("status").notNull().default("queued"),
  /** The user's image brief (pre-pass prompt assembly happens in the runner). */
  prompt: text("prompt").notNull(),
  /** Requested output size, e.g. "1024x1024". */
  size: text("size").notNull().default("1024x1024"),
  brandKitId: integer("brand_kit_id"),
  /** Optional /objects/... path of a tenant-scoped reference image. */
  referenceImagePath: text("reference_image_path"),
  /** Optional campaign/carousel correlation id for usage metering. */
  campaignId: text("campaign_id"),
  platform: text("platform"),
  /** Set on success: /objects/<tenantId>/uploads/<uuid> of the PNG. */
  imagePath: text("image_path"),
  provider: text("provider"),
  model: text("model"),
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

export type ImageGeneration = typeof imageGenerationsTable.$inferSelect;
