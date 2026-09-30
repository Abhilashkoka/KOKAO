import { pgTable, text, serial, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/** First code wins permanently; expiry ends earning, not attribution ownership. */
export const referralAttributionsTable = pgTable("referral_attributions", {
  tenantId: integer("tenant_id").primaryKey(),
  promoCodeId: integer("promo_code_id").notNull(),
  code: text("code").notNull(),
  ownerTenantId: integer("owner_tenant_id"),
  attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  grantCount: integer("grant_count").notNull().default(0),
  lastGrantAt: timestamp("last_grant_at", { withTimezone: true }),
}, t => [
  index("referral_attributions_code_idx").on(t.promoCodeId),
  index("referral_attributions_owner_idx").on(t.ownerTenantId),
]);
export type ReferralAttribution = typeof referralAttributionsTable.$inferSelect;

export const referralPurchaseGrantsTable = pgTable("referral_purchase_grants", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  promoCodeId: integer("promo_code_id").notNull(),
  ownerTenantId: integer("owner_tenant_id"),
  purchaseKind: text("purchase_kind").notNull(),
  purchaseRefId: text("purchase_ref_id").notNull(),
  grossPaise: integer("gross_paise").notNull(),
  creditPricePaise: integer("credit_price_paise").notNull(),
  buyerBonusBps: integer("buyer_bonus_bps").notNull().default(0),
  referrerBps: integer("referrer_bps").notNull().default(0),
  buyerBonusCreditsMilli: integer("buyer_bonus_credits_milli").notNull().default(0),
  referrerRewardCreditsMilli: integer("referrer_reward_credits_milli").notNull().default(0),
  slabIndex: integer("slab_index"),
  referralCountAtGrant: integer("referral_count_at_grant"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("referral_purchase_grants_purchase_unique").on(t.purchaseKind, t.purchaseRefId),
  index("referral_purchase_grants_owner_idx").on(t.ownerTenantId),
  index("referral_purchase_grants_tenant_idx").on(t.tenantId),
  index("referral_purchase_grants_created_idx").on(t.createdAt),
]);
export type ReferralPurchaseGrant = typeof referralPurchaseGrantsTable.$inferSelect;