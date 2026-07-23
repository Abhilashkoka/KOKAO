import { pgTable, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * App-level (platform-wide) configuration for the automatic signup credit
 * grant: a superadmin-defined bundle of caption/image/video credits handed to
 * every brand-new workspace exactly once, at first provisioning. Single row,
 * managed by superadmins only.
 *
 * `enabled` here is the CONFIGURED amounts' switch; the platform-wide kill
 * switch is the `signupCredits` feature flag (FEATURES catalog). Both must be
 * on for a grant to happen. No row = disabled with zero amounts.
 */
export const signupCreditSettingsTable = pgTable("signup_credit_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  captionCredits: integer("caption_credits").notNull().default(0),
  imageCredits: integer("image_credits").notNull().default(0),
  videoCredits: integer("video_credits").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SignupCreditSettings = typeof signupCreditSettingsTable.$inferSelect;
