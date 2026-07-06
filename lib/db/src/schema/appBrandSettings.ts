import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) branding, stored as a single row (id = 1).
 * Managed by superadmins only. When set, these values override the built-in
 * defaults everywhere in the app (nav, landing, favicon, title, theme colors).
 *
 * Image fields hold a PUBLIC served path (e.g. `/api/storage/public-objects/brand/<uuid>`)
 * because the logo/favicon are shown pre-authentication on the landing/auth pages.
 * All fields are nullable so an unset value falls back to the bundled default.
 */
export const appBrandSettingsTable = pgTable("app_brand_settings", {
  id: integer("id").primaryKey().default(1),
  appName: text("app_name"),
  logoUrl: text("logo_url"),
  iconUrl: text("icon_url"),
  primaryColor: text("primary_color"),
  backgroundColor: text("background_color"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AppBrandSettings = typeof appBrandSettingsTable.$inferSelect;
