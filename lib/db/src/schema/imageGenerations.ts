import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  jsonb,
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
 * status: queued | processing | succeeded | failed | cancelled
 */
export const imageGenerationsTable = pgTable("image_generations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  status: text("status").notNull().default("queued"),
  /** The user's image brief (pre-pass prompt assembly happens in the runner). */
  prompt: text("prompt").notNull(),
  /** Requested output size, e.g. "1024x1024". */
  size: text("size").notNull().default("1024x1024"),
  /**
   * How the route paid for this job: "quota" | "credit" | "wallet", recorded
   * at enqueue time so both cancel (still-queued jobs) and the stuck-job sweep
   * know whether a refund is owed. Nullable for legacy rows created before the
   * column existed (swept without refund).
   */
  funding: text("funding"),
  /**
   * Wallet-funded jobs: the wallet_ledger reserve row and the paise it took,
   * so the runner can settle it to the real cost — and cancel/sweep can hand
   * it back — long after the enqueueing request has gone.
   */
  walletReservationId: integer("wallet_reservation_id"),
  walletReservedPaise: integer("wallet_reserved_paise"),
  /**
   * How many image units this job reserved. One for an ordinary generation;
   * one per rendered layer for a layered job. Refunds read this instead of
   * assuming 1, so a failed six-layer job hands back six units. Nullable for
   * rows created before the column existed (treated as 1).
   */
  walletReservedUnits: integer("wallet_reserved_units"),
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
  /**
   * Layered generation: the job rendered each element as its own transparent
   * PNG instead of one flat image. `imagePath` still holds the flattened
   * composite so every existing consumer (library card, publish, download)
   * keeps working untouched.
   */
  layered: boolean("layered").notNull().default(false),
  /**
   * The quoted layer plan, persisted at enqueue time. The runner renders THIS
   * rather than re-planning: a second planner call could return a different
   * number of layers than the one the user was quoted and charged for.
   */
  layerPlan: jsonb("layer_plan").$type<Record<string, unknown>>(),
  /**
   * The editor layer document produced by a layered job, in exactly the shape
   * content_items.image_layers already uses ({ version: 1, basePath, layers }).
   * Deliberately the SAME vocabulary rather than a second one, so the existing
   * Konva editor opens a generated image with no new client code.
   */
  layerDoc: jsonb("layer_doc").$type<Record<string, unknown>>(),
  /**
   * Human-readable progress for a multi-call job ("Rendering layer 3 of 6"),
   * mirroring video_generations.stage. Null for single-call generations.
   */
  stage: text("stage"),
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
