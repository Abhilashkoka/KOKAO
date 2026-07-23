import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Superadmin-defined promotional codes that grant prepaid credits on
 * redemption. Codes are stored UPPERCASE (normalized on create and on
 * redeem) so matching is case-insensitive.
 *
 * Redemption is fully atomic: the redeem transaction locks the promo row
 * (SELECT ... FOR UPDATE), re-checks every constraint, appends a
 * promo_redemptions row, bumps redemptionCount, and grants the credits with
 * a matching credit_ledger entry — so concurrent submits can never double
 * credit or oversubscribe a capped code.
 */
export const promoCodesTable = pgTable(
  "promo_codes",
  {
    id: serial("id").primaryKey(),
    /** UPPERCASE code string, unique across all campaigns. */
    code: text("code").notNull(),
    /** Optional campaign name for grouping/attribution in metrics. */
    campaign: text("campaign"),
    captionCredits: integer("caption_credits").notNull().default(0),
    imageCredits: integer("image_credits").notNull().default(0),
    videoCredits: integer("video_credits").notNull().default(0),
    /**
     * Plan ids allowed to redeem (matched against tenants.plan). Null or
     * empty = any plan.
     */
    allowedPlans: text("allowed_plans").array(),
    /**
     * Audience targeting: "all" | "new" | "existing". "new" = tenant signed
     * up within `newTenantDays` days; "existing" = older than that.
     */
    audience: text("audience").notNull().default("all"),
    newTenantDays: integer("new_tenant_days").notNull().default(30),
    /** Global cap on successful redemptions. Null = unlimited. */
    maxRedemptions: integer("max_redemptions"),
    /** How many times one workspace may redeem this code. */
    perTenantLimit: integer("per_tenant_limit").notNull().default(1),
    /** Denormalized successful-redemption count (kept in the redeem tx). */
    redemptionCount: integer("redemption_count").notNull().default(0),
    /** Activation window. Null bounds = open-ended. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Instant kill switch for a leaked or finished code. */
    active: boolean("active").notNull().default(true),
    /** Set for bulk-generated batches so they can be listed/exported together. */
    batchId: text("batch_id"),
    /**
     * Referral codes only: the workspace that owns this personal code. On a
     * successful redemption the owner earns a referrer reward (their plan's
     * gamification settings decide how much). Null for ordinary promos.
     */
    ownerTenantId: integer("owner_tenant_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("promo_codes_code_unique").on(t.code),
    /**
     * One ACTIVE personal referral code per workspace: concurrent first-time
     * "get my invite code" requests can otherwise each mint their own code
     * (each with its own redemption cap).
     */
    uniqueIndex("promo_codes_owner_referral_unique")
      .on(t.ownerTenantId)
      .where(sql`campaign = 'referral' AND active`),
  ],
);

export type PromoCode = typeof promoCodesTable.$inferSelect;

/**
 * Append-only ledger of successful redemptions: who, when, what plan they
 * were on, and how many credits were granted at that moment.
 */
export const promoRedemptionsTable = pgTable(
  "promo_redemptions",
  {
    id: serial("id").primaryKey(),
    promoCodeId: integer("promo_code_id").notNull(),
    tenantId: integer("tenant_id").notNull(),
    planAtRedemption: text("plan_at_redemption").notNull(),
    captionCredits: integer("caption_credits").notNull().default(0),
    imageCredits: integer("image_credits").notNull().default(0),
    videoCredits: integer("video_credits").notNull().default(0),
    /** Referral codes only: what the code owner earned for this redemption. */
    referrerCaptionCredits: integer("referrer_caption_credits").notNull().default(0),
    referrerImageCredits: integer("referrer_image_credits").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("promo_redemptions_code_tenant_idx").on(t.promoCodeId, t.tenantId),
    index("promo_redemptions_tenant_idx").on(t.tenantId),
  ],
);

export type PromoRedemption = typeof promoRedemptionsTable.$inferSelect;

/**
 * Best-effort log of REJECTED redemption attempts (wrong plan, expired,
 * already used, unknown code, ...) for abuse spotting and support debugging.
 * Never blocks the request path.
 */
export const promoRedemptionFailuresTable = pgTable(
  "promo_redemption_failures",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** The (normalized) code the user typed — may not exist in promo_codes. */
    code: text("code").notNull(),
    /** Machine-readable reason, e.g. plan_not_allowed | expired | limit_reached. */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("promo_failures_created_idx").on(t.createdAt)],
);

export type PromoRedemptionFailure = typeof promoRedemptionFailuresTable.$inferSelect;
