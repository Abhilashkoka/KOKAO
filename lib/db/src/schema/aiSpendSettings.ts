import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) settings for the "AI amount spent" display.
 * Single row, managed by superadmins only.
 *
 * Base costs are stored in PAISE (like all billing amounts). The platform
 * fee is a percentage added on top of the base cost; the tenant-facing UI
 * shows one combined number labeled "AI amount spent" and never breaks the
 * fee out separately.
 */
export const aiSpendSettingsTable = pgTable("ai_spend_settings", {
  id: serial("id").primaryKey(),
  captionCostPaise: integer("caption_cost_paise").notNull().default(0),
  imageCostPaise: integer("image_cost_paise").notNull().default(0),
  /** Whole-number percentage added as the platform fee (0-1000). */
  feePercent: integer("fee_percent").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AiSpendSettings = typeof aiSpendSettingsTable.$inferSelect;
