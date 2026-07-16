import { pgTable, serial, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) settings for the "canvas design" image prompt
 * skill. Single row, managed by superadmins only.
 *
 * `enabled` is the global switch: when true (the default), every image
 * generation runs the two-step design-philosophy prompt enrichment unless a
 * tenant has an explicit per-tenant override (`tenants.designSkillEnabled`).
 */
export const designSkillSettingsTable = pgTable("design_skill_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type DesignSkillSettings = typeof designSkillSettingsTable.$inferSelect;
