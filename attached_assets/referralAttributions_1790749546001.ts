import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Referral attribution and purchase-triggered grants.
 *
 * Program A moves the referral payout from SIGNUP to CREDIT PURCHASE. Entering
 * a referral code no longer mints credits — it attaches the code to the
 * workspace. Credits are granted later, once money actually changes hands, and
 * are sized as a percentage of what was paid.
 *
 * Ordinary (non-referral) promo codes are untouched: they still grant on
 * redemption, exactly as before.
 */

/**
 * Which referral code a workspace is attributed to. One row per workspace —
 * first code entered wins and stays until it expires. Deliberately NOT a
 * history table: the promo_redemptions ledger already records every entry.
 */
export const referralAttributionsTable = pgTable(
  "referral_attributions",
  {
    /** One attribution per workspace. */
    tenantId: integer("tenant_id").primaryKey(),
    promoCodeId: integer("promo_code_id").notNull(),
    /** Denormalized for support/debugging; promo_codes.code is the source. */
    code: text("code").notNull(),
    /** The referring workspace. Null would mean a non-referral code attached. */
    ownerTenantId: integer("owner_tenant_id"),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * When this attribution stops earning. Set from the owner plan's
     * `referralAttributionDays` at attach time, so later admin changes do not
     * silently extend or shorten attributions already in the wild.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** How many purchases have paid out under this attribution. */
    grantCount: integer("grant_count").notNull().default(0),
    lastGrantAt: timestamp("last_grant_at", { withTimezone: true }),
  },
  (t) => [
    index("referral_attributions_code_idx").on(t.promoCodeId),
    index("referral_attributions_owner_idx").on(t.ownerTenantId),
  ],
);

export type ReferralAttribution =
  typeof referralAttributionsTable.$inferSelect;

/**
 * Append-only ledger: one row per purchase that paid a referral reward.
 *
 * The unique index on (purchaseKind, purchaseRefId) IS the idempotency
 * guarantee. Verify routes and webhook backstops both reach this code for the
 * same payment; the second one loses the insert race and grants nothing.
 *
 * Amounts are frozen at grant time — the bps that applied, the credit price
 * used for the paise→credits conversion, and the resulting milli-credits — so
 * a later rate-card or slab change never rewrites history.
 */
export const referralPurchaseGrantsTable = pgTable(
  "referral_purchase_grants",
  {
    id: serial("id").primaryKey(),
    /** The buyer. */
    tenantId: integer("tenant_id").notNull(),
    promoCodeId: integer("promo_code_id").notNull(),
    /** The referrer who earned. */
    ownerTenantId: integer("owner_tenant_id"),
    /** Matches invoices.kind: wallet_topup | credit_pack | plan. */
    purchaseKind: text("purchase_kind").notNull(),
    /** Gateway order/subscription reference — idempotency key with kind. */
    purchaseRefId: text("purchase_ref_id").notNull(),
    /** What was paid, in paise. Percentages are taken against this. */
    grossPaise: integer("gross_paise").notNull(),
    /** Paise-per-credit used for this conversion, frozen. */
    creditPricePaise: integer("credit_price_paise").notNull(),
    buyerBonusBps: integer("buyer_bonus_bps").notNull().default(0),
    referrerBps: integer("referrer_bps").notNull().default(0),
    buyerBonusCreditsMilli: integer("buyer_bonus_credits_milli")
      .notNull()
      .default(0),
    referrerRewardCreditsMilli: integer("referrer_reward_credits_milli")
      .notNull()
      .default(0),
    /** Which slab rung produced referrerBps, for support and analytics. */
    slabIndex: integer("slab_index"),
    /** Referral count at grant time — makes slab jumps auditable. */
    referralCountAtGrant: integer("referral_count_at_grant"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("referral_purchase_grants_purchase_unique").on(
      t.purchaseKind,
      t.purchaseRefId,
    ),
    index("referral_purchase_grants_owner_idx").on(t.ownerTenantId),
    index("referral_purchase_grants_tenant_idx").on(t.tenantId),
    index("referral_purchase_grants_created_idx").on(t.createdAt),
  ],
);

export type ReferralPurchaseGrant =
  typeof referralPurchaseGrantsTable.$inferSelect;
