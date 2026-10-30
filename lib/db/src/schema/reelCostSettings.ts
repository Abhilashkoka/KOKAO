import { pgTable, serial, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Showcase reel cost controls. Single row, superadmin-managed from
 * Admin → Quick Create. No row = the built-in defaults below. Every change is
 * also written to admin_audit_logs (action "reel_cost_settings_change").
 */
export const reelCostSettingsTable = pgTable("reel_cost_settings", {
  id: serial("id").primaryKey(),
  /** Image quality for dressing a model: "auto" lets the provider choose. */
  tryOnImageQuality: text("try_on_image_quality").notNull().default("medium"),
  /** Resolution for reel video clips: "480p" | "720p" | "1080p". */
  reelResolution: text("reel_resolution").notNull().default("720p"),
  /** Bars of music each look stays on screen by default (1-3). */
  defaultBars: integer("default_bars").notNull().default(1),
  /** Whether "Hero reel" (one AI clip + photo looks) is offered. */
  heroModeEnabled: boolean("hero_mode_enabled").notNull().default(true),
  /** Reel type selected when a reel opens: "video" | "hero" | "photo". */
  defaultReelStyle: text("default_reel_style").notNull().default("hero"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ReelCostSettings = typeof reelCostSettingsTable.$inferSelect;
