import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Superadmin-editable overrides for subscription plans, keyed by plan id
 * ("free" | "pro" | "business"). A missing row means the built-in defaults
 * from the API server's plan catalog apply. Limits use -1 for "unlimited".
 */
export const planSettingsTable = pgTable("plan_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceLabel: text("price_label").notNull(),
  captions: integer("captions").notNull(),
  images: integer("images").notNull(),
  brandKits: integer("brand_kits").notNull(),
  scheduledPosts: integer("scheduled_posts").notNull(),
  features: jsonb("features").$type<string[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PlanSettings = typeof planSettingsTable.$inferSelect;
