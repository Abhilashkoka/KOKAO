import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * Superadmin-editable subscription plans, keyed by plan id.
 *
 * Rows serve three purposes:
 * - Override a built-in default plan (free/pro/business): row with the same id.
 * - Define a custom plan: row with an id not among the defaults.
 * - Delete a built-in default plan: row with archived=true (custom plans are
 *   deleted by removing the row outright).
 *
 * A missing row means the built-in defaults from the API server's plan
 * catalog apply. Limits use -1 for "unlimited".
 */
export const planSettingsTable = pgTable("plan_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceLabel: text("price_label").notNull(),
  captions: integer("captions").notNull(),
  images: integer("images").notNull(),
  // Monthly AI video quota. Default 0 (credit-funded only) so pre-existing
  // custom plan rows keep working after the column is added.
  videos: integer("videos").notNull().default(0),
  // "Made with KOKAO.in" watermark on AI-generated images and videos for
  // workspaces on this plan. Default false so existing custom rows are
  // unaffected; the built-in free plan defaults to true in DEFAULT_PLANS.
  watermark: boolean("watermark").notNull().default(false),
  // Default billing mode for workspaces landing on this plan: "quota"
  // (monthly allowances + credit packs) or "wallet" (prepaid rupee wallet).
  // Applied on plan change unless the tenant has a manual billing-mode
  // override (tenants.billingModeOverriddenAt).
  billingMode: text("billing_mode").notNull().default("quota"),
  brandKits: integer("brand_kits").notNull(),
  scheduledPosts: integer("scheduled_posts").notNull(),
  features: jsonb("features").$type<string[]>().notNull(),
  // Team add-on: default seat allotment for workspaces on this plan.
  // 0 = the team feature is not included in this plan.
  teamSeats: integer("team_seats").notNull().default(0),
  // Razorpay billing: monthly price in paise (INR * 100). null = the plan is
  // not purchasable via Razorpay (free / manual-only plans).
  priceInr: integer("price_inr"),
  // The Razorpay Plan id backing paid subscriptions for this plan (created
  // automatically when a superadmin saves a price).
  razorpayPlanId: text("razorpay_plan_id"),
  // Yearly billing: total price for 12 months in paise. null = the plan has
  // no annual option (monthly only, or not sold online at all).
  priceInrYearly: integer("price_inr_yearly"),
  // The Razorpay Plan id (period=yearly) backing annual subscriptions.
  razorpayPlanIdYearly: text("razorpay_plan_id_yearly"),
  /** Cashfree plan ids minted when Cashfree is the active gateway. */
  cashfreePlanId: text("cashfree_plan_id"),
  cashfreePlanIdYearly: text("cashfree_plan_id_yearly"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PlanSettings = typeof planSettingsTable.$inferSelect;
