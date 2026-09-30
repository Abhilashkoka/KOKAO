import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Program B — the creator program.
 *
 * Deliberately separate from the promo/referral engine. A creator is an
 * signed-in KOKAO workspace owner, earns CASH rather than credits, is
 * approved before they get a code, and only supplies PAN and bank details at
 * first payout. Different fraud profile, different economics, different legal
 * surface — so: different tables.
 *
 * This bundle carries the full schema (including the payout tables) so the
 * migration happens once, but only accrual is implemented. No money leaves.
 */

// ---------------------------------------------------------------------------
// Creator identity
// ---------------------------------------------------------------------------

/**
 * status lifecycle:
 *   applied → approved → (suspended ⇄ approved) → closed
 *   applied → rejected
 * Only `approved` may hold an active code or accrue commission.
 */
export const creatorAccountsTable = pgTable(
  "creator_accounts",
  {
    id: serial("id").primaryKey(),
    /**
     * The promoter's KOKAO workspace. REQUIRED — a promoter signs up for KOKAO
     * first and applies from inside the product. That gives the program a real
     * verified identity to hang on (Clerk sign-in), makes "can't use your own
     * code" enforceable, and means every promoter has at least seen the thing
     * they're promoting.
     */
    tenantId: integer("tenant_id").notNull(),
    status: text("status").notNull().default("applied"),
    displayName: text("display_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    phone: text("phone"),
    /** [{ platform, handle, url, followers }] as declared at application. */
    channels: jsonb("channels").$type<
      { platform: string; handle: string; url?: string; followers?: number }[]
    >(),
    /** healthcare | finance | legal | fitness | general | … free text. */
    vertical: text("vertical"),
    /**
     * Self-declared at application. Routes the creator to stricter content
     * guidelines (promote the tool, never patient outcomes or clinical claims)
     * and flags them for a closer look at approval. Not a qualification claim.
     */
    isRegisteredPractitioner: boolean("is_registered_practitioner")
      .notNull()
      .default(false),
    agreementVersion: text("agreement_version"),
    agreementAcceptedAt: timestamp("agreement_accepted_at", {
      withTimezone: true,
    }),
    /** Per-creator negotiated rate. Null = use the slab ladder. */
    commissionOverrideBps: integer("commission_override_bps"),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedByTenantId: integer("reviewed_by_tenant_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Rejection or suspension reason, shown to the creator. */
    statusReason: text("status_reason"),
    /** Derived fraud flags; see lib/creatorCommissions.ts. */
    riskFlags: jsonb("risk_flags").$type<Record<string, unknown>>(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** One promoter account per workspace. */
    uniqueIndex("creator_accounts_tenant_unique").on(t.tenantId),
    uniqueIndex("creator_accounts_email_unique").on(t.contactEmail),
    index("creator_accounts_status_idx").on(t.status),
  ],
);

export type CreatorAccount = typeof creatorAccountsTable.$inferSelect;

/**
 * Collected at FIRST PAYOUT REQUEST, never before — a creator does not hand
 * over a PAN to get a code.
 *
 * The unique index on panHash is the identity control: one payout identity per
 * PAN means a creator cannot run several accounts and collect on each. The
 * bank account hash is stored so a payout destination can be cross-checked
 * against the payment instruments used by tenants that redeemed this creator's
 * code — the same account paying in and receiving out is the tell that no
 * purchase-time signal can give you.
 */
export const creatorPayoutIdentitiesTable = pgTable(
  "creator_payout_identities",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull(),
    /** Pepper-keyed HMAC-SHA256 of the normalized PAN. Never store the raw value. */
    panHash: text("pan_hash").notNull(),
    panLast4: text("pan_last4"),
    bankAccountHash: text("bank_account_hash"),
    bankLast4: text("bank_last4"),
    ifsc: text("ifsc"),
    beneficiaryName: text("beneficiary_name"),
    version: integer("version").notNull().default(1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verificationRef: text("verification_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("creator_payout_identities_pan_unique").on(t.panHash),
    uniqueIndex("creator_payout_identities_creator_unique").on(t.creatorId),
    index("creator_payout_identities_bank_idx").on(t.bankAccountHash),
  ],
);

export type CreatorPayoutIdentity =
  typeof creatorPayoutIdentitiesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Codes and attribution
// ---------------------------------------------------------------------------

export const creatorCodesTable = pgTable(
  "creator_codes",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull(),
    /** UPPERCASE, unique across creator codes. */
    code: text("code").notNull(),
    /** "single_use" | "multi_use" — admin-locked per code. */
    reusePolicy: text("reuse_policy").notNull().default("multi_use"),
    maxRedemptions: integer("max_redemptions"),
    redemptionCount: integer("redemption_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    /** Optional label so a creator can run several campaigns. */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("creator_codes_code_unique").on(t.code),
    index("creator_codes_creator_idx").on(t.creatorId),
  ],
);

export type CreatorCode = typeof creatorCodesTable.$inferSelect;

/**
 * One creator owns a workspace — first touch wins, and a workspace can never
 * carry both a creator attribution and a user-referral attribution (the attach
 * paths cross-check each other, so a purchase is never paid twice).
 */
export const creatorAttributionsTable = pgTable(
  "creator_attributions",
  {
    tenantId: integer("tenant_id").primaryKey(),
    creatorId: integer("creator_id").notNull(),
    creatorCodeId: integer("creator_code_id").notNull(),
    code: text("code").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Frozen from settings at attach time. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantCount: integer("grant_count").notNull().default(0),
    lastGrantAt: timestamp("last_grant_at", { withTimezone: true }),
    /** Signals captured at attach; feed the commission risk score. */
    attachSignals: jsonb("attach_signals").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("creator_attributions_creator_idx").on(t.creatorId),
    index("creator_attributions_code_idx").on(t.creatorCodeId),
  ],
);

export type CreatorAttribution = typeof creatorAttributionsTable.$inferSelect;

// ---------------------------------------------------------------------------
// The commission ledger
// ---------------------------------------------------------------------------

/**
 * One row per qualifying purchase.
 *
 *   pending ──(hold elapsed AND consumption ≥ threshold)──▶ payable ──▶ in_payout ──▶ paid
 *      │                                    │
 *      │                             high risk ──▶ held ──(admin clears)──▶ payable
 *      └── refund/chargeback ──▶ reversed        payable past expiry ──▶ expired
 *
 * Amounts are PAISE — this is cash owed, not credits. Everything that decided
 * the amount is frozen on the row so a later settings change never rewrites
 * what someone earned.
 */
export const creatorCommissionsTable = pgTable(
  "creator_commissions",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull(),
    creatorCodeId: integer("creator_code_id").notNull(),
    /** The buyer's workspace. */
    tenantId: integer("tenant_id").notNull(),
    /** Set when the invoice for this purchase exists; the revenue anchor. */
    invoiceId: integer("invoice_id"),
    purchaseKind: text("purchase_kind").notNull(),
    purchaseRefId: text("purchase_ref_id").notNull(),
    refundedPaise: integer("refunded_paise").notNull().default(0),
    refundedCommissionPaise: integer("refunded_commission_paise").notNull().default(0),
    grossPaise: integer("gross_paise").notNull(),
    /** Gross less refunds/chargebacks recognised so far. */
    netPaise: integer("net_paise").notNull(),
    commissionBps: integer("commission_bps").notNull(),
    commissionPaise: integer("commission_paise").notNull(),
    /** Which slab rung produced the rate; null when an override applied. */
    slabIndex: integer("slab_index"),
    /** Bonus credits the buyer received, in milli-credits. */
    buyerBonusCreditsMilli: integer("buyer_bonus_credits_milli")
      .notNull()
      .default(0),
    state: text("state").notNull().default("pending"),
    riskScore: integer("risk_score").notNull().default(0),
    riskSignals: jsonb("risk_signals").$type<Record<string, unknown>>(),
    /** Credits this purchase bought, for the consumption gate. */
    creditsPurchasedMilli: integer("credits_purchased_milli")
      .notNull()
      .default(0),
    /** Last computed burn ratio, 0–10000 bps. */
    consumptionBps: integer("consumption_bps").notNull().default(0),
    /** Refund window close; nothing matures before this. */
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    maturedAt: timestamp("matured_at", { withTimezone: true }),
    /** Unclaimed earnings lapse here. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    payoutId: integer("payout_id"),
    stateReason: text("state_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("creator_commissions_purchase_unique").on(
      t.purchaseKind,
      t.purchaseRefId,
    ),
    index("creator_commissions_creator_state").on(t.creatorId, t.state),
    index("creator_commissions_state_hold").on(t.state, t.holdUntil),
    index("creator_commissions_tenant_idx").on(t.tenantId),
    index("creator_commissions_payout_idx").on(t.payoutId),
  ],
);

export type CreatorCommission = typeof creatorCommissionsTable.$inferSelect;

/**
 * Manual payout batches. No gateway transfer automation is installed.
 * A reserve is withheld from each batch and released later, so a late
 * chargeback lands on money still held rather than money already gone.
 */
export const creatorPayoutsTable = pgTable(
  "creator_payouts",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull(),
    payoutIdentityId: integer("payout_identity_id"),
    grossPaise: integer("gross_paise").notNull(),
    tdsPaise: integer("tds_paise").notNull().default(0),
    tdsRateBps: integer("tds_rate_bps").notNull().default(0),
    reserveHeldPaise: integer("reserve_held_paise").notNull().default(0),
    /** Frozen at batching; never use current settings to release old reserves. */
    reserveReleaseDays: integer("reserve_release_days").notNull().default(90),
    reserveConsumedPaise: integer("reserve_consumed_paise").notNull().default(0),
    identityVersion: integer("identity_version"),
    /** Masked review destination only. Not an executable bank instruction. */
    destinationSnapshot: jsonb("destination_snapshot").$type<{
      beneficiaryName: string; bankLast4: string; ifsc: string;
    }>(),
    reserveReleasedAt: timestamp("reserve_released_at", { withTimezone: true }),
    netPaise: integer("net_paise").notNull(),
    gateway: text("gateway"),
    gatewayRef: text("gateway_ref"),
    status: text("status").notNull().default("draft"),
    failureReason: text("failure_reason"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("creator_payouts_creator_idx").on(t.creatorId),
    index("creator_payouts_status_idx").on(t.status),
  ],
);

export type CreatorPayout = typeof creatorPayoutsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Singleton, superadmin-managed. The unique index makes it a hard singleton. */
export const creatorProgramSettingsTable = pgTable(
  "creator_program_settings",
  {
    id: serial("id").primaryKey(),
    singleton: boolean("singleton").notNull().default(true),
    /** [{ minReferrals, commissionBps }] — resolved live per creator. */
    commissionSlabs: jsonb("commission_slabs").$type<
      { minReferrals: number; commissionBps: number }[]
    >(),
    /** Bonus credits for the buyer, in bps of the purchase. */
    buyerBonusBps: integer("buyer_bonus_bps").notNull().default(1000),
    buyerBonusExpiryDays: integer("buyer_bonus_expiry_days")
      .notNull()
      .default(90),
    /** Refund window; nothing matures before it closes. */
    holdDays: integer("hold_days").notNull().default(30),
    /** Referred workspace must burn this share of what it bought. */
    consumptionThresholdBps: integer("consumption_threshold_bps")
      .notNull()
      .default(2500),
    /** Withheld from each payout, released after reserveReleaseDays. */
    reserveBps: integer("reserve_bps").notNull().default(1000),
    reserveReleaseDays: integer("reserve_release_days").notNull().default(90),
    minPayoutPaise: integer("min_payout_paise").notNull().default(100_000),
    /** Unclaimed payable earnings lapse after this. */
    earningExpiryDays: integer("earning_expiry_days").notNull().default(365),
    /** How long an attached creator code keeps earning for a workspace. */
    attributionDays: integer("attribution_days").notNull().default(180),
    /** "first_purchase" | "every_purchase" */
    triggerMode: text("trigger_mode").notNull().default("every_purchase"),
    payoutCadence: text("payout_cadence").notNull().default("monthly"),
    /** TDS withheld on commission. Confirm the rate with your CA. */
    tdsRateBps: integer("tds_rate_bps").notNull().default(200),
    autoApproveCreators: boolean("auto_approve_creators")
      .notNull()
      .default(false),
    /** Commissions scoring at or above this are held for manual review. */
    riskHoldThreshold: integer("risk_hold_threshold").notNull().default(50),
    /** First N commissions from a new creator always get reviewed. */
    newCreatorReviewCount: integer("new_creator_review_count")
      .notNull()
      .default(3),
    programEnabled: boolean("program_enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("creator_program_settings_singleton").on(t.singleton)],
);

export type CreatorProgramSettings =
  typeof creatorProgramSettingsTable.$inferSelect;
