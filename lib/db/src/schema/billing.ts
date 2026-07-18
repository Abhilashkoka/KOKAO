import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Razorpay subscription records, one active row per tenant at most.
 * The tenant's `plan` column stays the source of truth for entitlements;
 * this table tracks the payment state that backs it.
 */
export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  planId: text("plan_id").notNull(),
  razorpaySubscriptionId: text("razorpay_subscription_id").notNull().unique(),
  /**
   * created | authenticated | active | halted | cancelled | completed | expired
   * (mirrors Razorpay subscription statuses; "created" means checkout not
   * finished yet).
   */
  status: text("status").notNull().default("created"),
  /** Billing cycle chosen at checkout: "monthly" | "yearly". */
  billingCycle: text("billing_cycle").notNull().default("monthly"),
  /** End of the currently paid period (from Razorpay charge webhooks). */
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  /** True when the user asked to cancel at the end of the paid period. */
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Subscription = typeof subscriptionsTable.$inferSelect;

/**
 * Superadmin-defined prepaid credit packs purchasable via one-time Razorpay
 * payments. Prices are stored in paise (INR * 100) to avoid float issues.
 */
export const creditPacksTable = pgTable("credit_packs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  pricePaise: integer("price_paise").notNull(),
  captionCredits: integer("caption_credits").notNull().default(0),
  imageCredits: integer("image_credits").notNull().default(0),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CreditPack = typeof creditPacksTable.$inferSelect;

/**
 * Per-tenant credit balance (captions/images). Mutated only inside a
 * transaction holding SELECT ... FOR UPDATE on the row, with a matching
 * append to credit_ledger, so the balance is always auditable.
 */
export const creditBalancesTable = pgTable("credit_balances", {
  tenantId: integer("tenant_id").primaryKey(),
  captionCredits: integer("caption_credits").notNull().default(0),
  imageCredits: integer("image_credits").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CreditBalance = typeof creditBalancesTable.$inferSelect;

/**
 * Append-only credit history: purchases (+), admin grants (+/-), spends (-).
 * `razorpayOrderId` is unique per purchase so a replayed verification or a
 * webhook backstop can never credit the same payment twice.
 */
export const creditLedgerTable = pgTable(
  "credit_ledger",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** purchase | spend | admin_grant */
    kind: text("kind").notNull(),
    captionDelta: integer("caption_delta").notNull().default(0),
    imageDelta: integer("image_delta").notNull().default(0),
    /** Set for purchases; unique to make crediting idempotent per order. */
    razorpayOrderId: text("razorpay_order_id"),
    creditPackId: integer("credit_pack_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credit_ledger_order_unique").on(t.razorpayOrderId)],
);

export type CreditLedgerEntry = typeof creditLedgerTable.$inferSelect;

/**
 * Processed Razorpay webhook events, keyed by Razorpay's event id, so event
 * redelivery is idempotent.
 */
export const razorpayEventsTable = pgTable("razorpay_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
