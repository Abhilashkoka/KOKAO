import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  numeric,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { videoGenerationsTable } from "./videoGenerations";

/**
 * Prepaid RUPEE wallet: a money balance per tenant, topped up via Razorpay and
 * drawn down by the real cost of each AI generation.
 *
 * This sits ALONGSIDE the existing plan-quota / unit-credit rails and never
 * replaces them silently. A workspace draws from exactly one rail, chosen by
 * `tenants.billingMode` ("quota" = today's behaviour, "wallet" = money), and
 * the whole module is behind the `wallet` platform kill switch. With the
 * switch off, nothing here is ever consulted.
 *
 * Every amount is an integer in PAISE (INR * 100), like the rest of billing.
 *
 * Money display is GST-EXCLUSIVE everywhere inside the app: balances, costs
 * and recharge amounts are base rupees. GST is added once, at the Razorpay
 * checkout step, and the wallet is credited only the base.
 */

/**
 * Per-tenant wallet balance. Mutated only inside a transaction holding
 * SELECT ... FOR UPDATE on the row, with a matching wallet_ledger append, so
 * concurrent generations can never double-spend and the ledger always sums to
 * the stored balance.
 */
export const walletBalancesTable = pgTable("wallet_balances", {
  tenantId: integer("tenant_id").primaryKey(),
  balancePaise: integer("balance_paise").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WalletBalance = typeof walletBalancesTable.$inferSelect;

/**
 * Append-only rupee history. `amountPaise` is the SIGNED delta actually
 * applied to the balance, so SUM(amount_paise) always equals the balance.
 *
 * The generation lifecycle writes up to three rows:
 *   reserve  (-estimate)  before the provider call, so two concurrent
 *                         generations cannot both spend the last rupee
 *   settle   (±diff)      after it finishes, trueing the estimate up or down
 *                         to the real provider cost plus the platform fee
 *   refund   (+estimate)  instead of settle, when the generation failed
 *
 * `estimated` marks a settle that had to fall back to the admin display rate
 * because the model was missing from the price catalog. Those rows keep the
 * provider/model/token figures so a later `true_up` can charge the difference
 * once the admin fills the price in.
 */
export const walletLedgerTable = pgTable(
  "wallet_ledger",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** topup | reserve | settle | refund | true_up | admin_credit | admin_debit */
    kind: text("kind").notNull(),
    /** Signed delta applied to the balance, in paise. */
    amountPaise: integer("amount_paise").notNull(),
    /** Top-ups: the GST-exclusive amount credited to the wallet. */
    baseAmountPaise: integer("base_amount_paise"),
    /** Top-ups: the GST charged on top at checkout (never credited). */
    gstAmountPaise: integer("gst_amount_paise"),
    /** Top-ups: the GST percentage in effect when the order was created. */
    gstPercent: integer("gst_percent"),
    /** Set for top-ups; unique so a replayed webhook can never credit twice. */
    razorpayOrderId: text("razorpay_order_id"),
    /** Set for Cashfree top-ups; unique for idempotent crediting. */
    cashfreeOrderId: text("cashfree_order_id"),
    /** settle/refund/true_up: the reserve row this resolves. */
    reservationId: integer("reservation_id"),
    /** caption | image | video — what was generated. */
    usageKind: text("usage_kind"),
    /**
     * What this charge produced, when known at charge time:
     * content (library item) | imageJob | videoJob | campaign.
     * Lets the billing UI link a ledger line back to the item it paid for.
     */
    refKind: text("ref_kind"),
    /** Identifier matching refKind: content id, job id, or campaign uuid. */
    refId: text("ref_id"),
    provider: text("provider"),
    model: text("model"),
    /** Exact provider cost before platform fee; NULL means unavailable. */
    providerCostPaise: integer("provider_cost_paise"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    providerCredits: numeric("provider_credits", { precision: 20, scale: 8 }),
    providerRequestId: text("provider_request_id"),
    /** True when the charge used the display-rate fallback, not a real price. */
    estimated: boolean("estimated").notNull().default(false),
    /** Set on an estimated row once a true_up has charged the difference. */
    trueUpAt: timestamp("true_up_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wallet_ledger_order_unique").on(t.razorpayOrderId),
    uniqueIndex("wallet_ledger_cf_order_unique").on(t.cashfreeOrderId),
    index("wallet_ledger_tenant_created").on(t.tenantId, t.createdAt),
    index("wallet_ledger_pending_price").on(t.estimated, t.trueUpAt),
  ],
);

export type WalletLedgerEntry = typeof walletLedgerTable.$inferSelect;

/**
 * Durable outbox for wallet reservations whose generated work succeeded.
 *
 * Every successful caller records the exact target charge here before trying
 * the balance mutation. A unique reservation id makes enqueueing idempotent,
 * while the retry worker's pending/processing claim prevents duplicate work.
 * The wallet ledger remains the source of truth for whether a reservation was
 * actually settled; this table only drives retries and operator visibility.
 */
export const walletSettlementRetriesTable = pgTable(
  "wallet_settlement_retries",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    reservationId: integer("reservation_id").notNull(),
    reservedPaise: integer("reserved_paise").notNull(),
    reservedUnits: integer("reserved_units").notNull().default(1),
    usageKind: text("usage_kind").notNull(),
    targetChargePaise: integer("target_charge_paise").notNull(),
    estimated: boolean("estimated").notNull().default(false),
    provider: text("provider"),
    model: text("model"),
    /** Exact provider cost before platform fee; NULL means unavailable. */
    providerCostPaise: integer("provider_cost_paise"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    providerCredits: numeric("provider_credits", { precision: 20, scale: 8 }),
    providerRequestId: text("provider_request_id"),
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    /** pending | processing | settled | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("wallet_settlement_retries_reservation_unique").on(t.reservationId),
    index("wallet_settlement_retries_due_idx").on(t.status, t.nextAttemptAt),
    index("wallet_settlement_retries_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

export type WalletSettlementRetry = typeof walletSettlementRetriesTable.$inferSelect;

/**
 * Durable provider-operation receipt for synchronous AI work.
 *
 * The row is created before the provider call. A confirmed provider outcome is
 * written here before the route proceeds to its wallet-settlement handoff, so
 * a restart can resolve the original reservation without regenerating work.
 * The reservation ceiling is frozen when the operation starts. Metered
 * providers may atomically replace it with an exact receipt-derived target
 * when success is confirmed.
 */
export const walletProviderOperationsTable = pgTable(
  "wallet_provider_operations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    reservationId: integer("reservation_id").notNull(),
    reservedPaise: integer("reserved_paise").notNull(),
    reservedUnits: integer("reserved_units").notNull().default(1),
    usageKind: text("usage_kind").notNull(),
    operationKind: text("operation_kind").notNull(),
    /** Deterministic provider/resource key when the provider can reconcile it. */
    operationKey: text("operation_key"),
    /** pending | succeeded | failed | settlement_queued | settled | refunded */
    status: text("status").notNull().default("pending"),
    targetChargePaise: integer("target_charge_paise").notNull(),
    estimated: boolean("estimated").notNull().default(false),
    provider: text("provider"),
    model: text("model"),
    /** Exact provider cost before platform fee; NULL means unavailable. */
    providerCostPaise: integer("provider_cost_paise"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    providerCredits: numeric("provider_credits", { precision: 20, scale: 8 }),
    providerRequestId: text("provider_request_id"),
    providerResultId: text("provider_result_id"),
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    lastError: text("last_error"),
    providerFinishedAt: timestamp("provider_finished_at", { withTimezone: true }),
    /** Gives the live request a short window to perform its normal handoff. */
    recoverAfter: timestamp("recover_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("wallet_provider_operations_reservation_unique").on(t.reservationId),
    uniqueIndex("wallet_provider_operations_provider_result_unique").on(
      t.provider,
      t.providerResultId,
    ),
    index("wallet_provider_operations_recovery_idx").on(t.status, t.recoverAfter),
    index("wallet_provider_operations_key_idx").on(t.operationKind, t.operationKey),
    index("wallet_provider_operations_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

export type WalletProviderOperation = typeof walletProviderOperationsTable.$inferSelect;

/**
 * Platform-wide wallet settings. Single row, superadmin-managed.
 *
 * The platform fee percentage is NOT duplicated here — the wallet reuses
 * `ai_spend_settings.feePercent` and its per-caption / per-image display
 * rates, so one set of admin numbers drives both the "AI amount spent"
 * display and what the wallet actually charges.
 */
export const walletSettingsTable = pgTable("wallet_settings", {
  id: serial("id").primaryKey(),
  /** Whole-number GST percentage added at checkout (0-100). */
  gstPercent: integer("gst_percent").notNull().default(18),
  /** Smallest allowed top-up, GST-exclusive. Default ₹100. */
  minTopupPaise: integer("min_topup_paise").notNull().default(10000),
  /** Warn the tenant below this balance. 0 = no warning. */
  lowBalanceThresholdPaise: integer("low_balance_threshold_paise")
    .notNull()
    .default(0),
  /**
   * Display-rate fallback for video generations, in paise. ai_spend_settings
   * carries caption and image rates but has no video figure, so the wallet
   * keeps video's fallback here rather than charging video as free.
   */
  videoCostPaise: integer("video_cost_paise").notNull().default(0),
  /**
   * Persisted per-group consecutive-failure counters for the true-up sweep.
   * Keyed by `${usageKind}:${model}`, values are `{ count, lastError }`.
   * Survives server restarts so the alert threshold is measured across the
   * real failure duration, not just within one server run.
   */
  trueUpFailCounts: jsonb("true_up_fail_counts")
    .$type<Record<string, { count: number; lastError: string | null }>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WalletSettings = typeof walletSettingsTable.$inferSelect;

/** Immutable v2 delivery billing snapshot.  The service freezes membership
 * and the fee before any ledger correction is attempted. */
export const videoDeliveryBillingManifestsTable = pgTable(
  "video_delivery_billing_manifests",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    completedJobId: integer("completed_job_id").notNull()
      .references(() => videoGenerationsTable.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    policyVersion: integer("policy_version").notNull().default(2),
    status: text("status").notNull().default("pending_cost"),
    feePercent: integer("fee_percent").notNull(),
    rawProviderCostPaise: integer("raw_provider_cost_paise"),
    targetChargePaise: integer("target_charge_paise"),
    previouslyChargedPaise: integer("previously_charged_paise"),
    appliedPaise: integer("applied_paise"),
    correctionReservationId: integer("correction_reservation_id"),
    reservationIds: jsonb("reservation_ids").$type<number[]>().notNull().default([]),
    idempotencyKey: text("idempotency_key").notNull(),
    idempotencyVersion: integer("idempotency_version").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("video_delivery_billing_completed_job_unique").on(t.completedJobId),
    uniqueIndex("video_delivery_billing_idempotency_unique").on(t.tenantId, t.idempotencyKey),
    index("video_delivery_billing_tenant_idx").on(t.tenantId, t.createdAt),
    check("video_delivery_billing_policy_v2_check", sql`${t.policyVersion} = 2`),
    check("video_delivery_billing_fee_check", sql`${t.feePercent} >= 0 AND ${t.feePercent} <= 1000`),
  ],
);

export type VideoDeliveryBillingManifest =
  typeof videoDeliveryBillingManifestsTable.$inferSelect;

export const videoDeliveryBillingItemsTable = pgTable(
  "video_delivery_billing_items",
  {
    id: serial("id").primaryKey(),
    manifestId: integer("manifest_id").notNull()
      .references(() => videoDeliveryBillingManifestsTable.id, { onDelete: "cascade" }),
    operationIdentity: text("operation_identity").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider"),
    model: text("model"),
    rawProviderCostPaise: integer("raw_provider_cost_paise"),
    providerReservationId: integer("provider_reservation_id"),
    providerRequestId: text("provider_request_id"),
    providerResultId: text("provider_result_id"),
    artifactPath: text("artifact_path"),
    artifactHash: text("artifact_hash"),
    inclusionReason: text("inclusion_reason").notNull(),
    independentlySettled: boolean("independently_settled").notNull().default(false),
    unmetered: boolean("unmetered").notNull().default(false),
    sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("video_delivery_billing_item_identity_unique").on(
      t.manifestId,
      t.operationIdentity,
    ),
    index("video_delivery_billing_item_manifest_idx").on(t.manifestId),
    check("video_delivery_billing_item_identity_check", sql`length(trim(${t.operationIdentity})) > 0`),
    check("video_delivery_billing_item_cost_check", sql`${t.rawProviderCostPaise} IS NULL OR ${t.rawProviderCostPaise} >= 0`),
  ],
);

export type VideoDeliveryBillingItem = typeof videoDeliveryBillingItemsTable.$inferSelect;

/** First-delivery ownership of reusable independently-settled inputs. */
export const videoDeliveryInputClaimsTable = pgTable(
  "video_delivery_input_claims",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    operationIdentity: text("operation_identity").notNull(),
    manifestId: integer("manifest_id").notNull()
      .references(() => videoDeliveryBillingManifestsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("video_delivery_input_claim_tenant_operation_unique")
      .on(t.tenantId, t.operationIdentity),
    index("video_delivery_input_claim_manifest_idx").on(t.manifestId),
    check("video_delivery_input_claim_identity_check",
      sql`length(trim(${t.operationIdentity})) > 0`),
  ],
);
