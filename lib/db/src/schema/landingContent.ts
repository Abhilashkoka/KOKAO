import { pgTable, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Platform-wide public landing page content, stored as a single row (id = 1).
 * Managed by superadmins in the admin "Landing Page" editor. The `content`
 * column holds the entire landing page document (hero, features, pricing,
 * testimonials, FAQ, privacy policy, ...) as validated JSON.
 *
 * NULL content means "use the bundled default document" — the API always
 * returns an effective document, never null, so the public page can render
 * before anything has been customized.
 */
export const landingContentTable = pgTable("landing_content_settings", {
  id: integer("id").primaryKey().default(1),
  content: jsonb("content"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type LandingContentRow = typeof landingContentTable.$inferSelect;
