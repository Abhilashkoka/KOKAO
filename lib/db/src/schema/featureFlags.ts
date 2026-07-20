import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Platform-wide feature kill switches, managed by superadmins only.
 *
 * One row per feature key (see the FEATURES catalog in the api-server's
 * lib/featureFlags.ts). No row = enabled (the default), mirroring the
 * ads_settings / design_skill_settings pattern. When a feature is disabled,
 * its API routes return 403 feature_disabled for every tenant and the web
 * app hides the corresponding pages/nav items. Admin routes are never gated.
 */
export const featureFlagsTable = pgTable("feature_flags", {
  feature: text("feature").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type FeatureFlagRow = typeof featureFlagsTable.$inferSelect;
