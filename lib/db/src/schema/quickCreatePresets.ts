import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Quick Create starters, managed by a superadmin.
 *
 * A starter only pre-fills the one-screen Quick Create form (prompt, length,
 * shape, music). It carries no tenant assets, so one platform-wide list serves
 * every workspace. Unpublished rows stay visible to superadmins only.
 */
export const QUICK_CREATE_VERTICALS = [
  "fashion",
  "product",
  "service",
  "doctor",
  "ca",
] as const;
export type QuickCreateVertical = (typeof QUICK_CREATE_VERTICALS)[number];

export const QUICK_CREATE_ASPECTS = ["9:16", "1:1", "16:9"] as const;
export type QuickCreateAspect = (typeof QUICK_CREATE_ASPECTS)[number];

export const quickCreatePresetsTable = pgTable(
  "quick_create_presets",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    vertical: text("vertical").$type<QuickCreateVertical>().notNull(),
    prompt: text("prompt").notNull(),
    durationSec: integer("duration_sec").notNull().default(10),
    aspect: text("aspect").$type<QuickCreateAspect>().notNull().default("9:16"),
    /** Shown on the photo step, e.g. "Add a photo of the saree". */
    photoHint: text("photo_hint"),
    musicPrompt: text("music_prompt"),
    published: boolean("published").notNull().default(false),
    /** Lower comes first within a vertical. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("quick_create_presets_published_idx").on(table.published, table.vertical)],
);

export type QuickCreatePreset = typeof quickCreatePresetsTable.$inferSelect;
export type InsertQuickCreatePreset = typeof quickCreatePresetsTable.$inferInsert;
