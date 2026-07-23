import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Reusable visual assets for AI generation. A visual asset is a fixed image a
 * tenant uploads once (product shot, mascot, prop, background, logo lockup)
 * and reuses across the AI Studio: as a reference image for image generation
 * or as the source photo for image-to-video generation.
 *
 * Capped per tenant (see MAX_VISUAL_ASSETS in the routes) so the library
 * stays a curated set of anchors, not a general media store.
 */
export const visualAssetsTable = pgTable("visual_assets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  /** Uploaded image (/objects/<tenantId>/uploads/...). */
  imagePath: text("image_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VisualAsset = typeof visualAssetsTable.$inferSelect;
