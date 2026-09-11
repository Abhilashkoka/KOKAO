import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * THE CREDIT BALANCE.
 *
 * One row per workspace, holding two buckets that behave differently:
 *
 *   purchased — credits someone paid for. These NEVER expire. Expiring money
 *               a customer handed over reads as theft and buys nothing, since
 *               the margin is already in the credit price.
 *   granted   — a plan's monthly allowance, a signup bonus, a promo, an admin
 *               top-up. These DO expire, so a free grant does not sit on the
 *               books forever.
 *
 * Spending draws from `granted` FIRST, so an allowance is used before it
 * expires rather than quietly wasted while purchased credits drain.
 *
 * Expiry is lazy: any read or write past `grantedExpiresAt` zeroes the granted
 * bucket and writes an `expire` ledger row. No cron, and no drift between when
 * a cron last ran and what the balance says.
 *
 * Amounts are MILLI-CREDITS (thousandths) as integers, matching credit_rates,
 * so a caption priced at a fifth of a credit stays exact.
 */
export const creditAccountsTable = pgTable("credit_accounts", {
  tenantId: integer("tenant_id").primaryKey(),
  /** Paid-for credits. Never expire. */
  purchasedMilli: integer("purchased_milli").notNull().default(0),
  /** Allowance and bonus credits. Expire at grantedExpiresAt. */
  grantedMilli: integer("granted_milli").notNull().default(0),
  /** When the granted bucket lapses. Null means the bucket is empty. */
  grantedExpiresAt: timestamp("granted_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CreditAccount = typeof creditAccountsTable.$inferSelect;

/**
 * Append-only credit history. The two delta columns always sum to the two
 * balance columns, so the ledger is both the audit trail and the
 * reconciliation.
 *
 * kinds:
 *   grant_plan     monthly allowance for a paid period (idempotent per period)
 *   grant_signup   welcome bundle
 *   grant_promo    promo code or gamification reward
 *   grant_admin    superadmin adjustment (may be negative)
 *   purchase       a paid top-up
 *   spend          a metered provider call
 *   refund         that call failed, credits returned
 *   expire         the granted bucket lapsed
 *   migrate        converted from a legacy quota / credit-pack / rupee balance
 */
export const creditAccountLedgerTable = pgTable(
  "credit_account_ledger",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    kind: text("kind").notNull(),
    /** Signed delta actually applied to the purchased bucket, in milli. */
    purchasedDeltaMilli: integer("purchased_delta_milli").notNull().default(0),
    /** Signed delta actually applied to the granted bucket, in milli. */
    grantedDeltaMilli: integer("granted_delta_milli").notNull().default(0),
    /** Combined balance after this row, for fast statements. */
    balanceAfterMilli: integer("balance_after_milli").notNull().default(0),
    /** spend/refund: which rate key was charged. */
    rateKey: text("rate_key"),
    /** spend/refund: what it was for — videoJob | imageJob | content. */
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    /**
     * Makes a grant, purchase or spend idempotent. A monthly plan grant uses
     * `plan:<tenantId>:<periodEnd>`, so a redelivered subscription webhook can
     * never grant the same period twice; a metered spend can pass the job's
     * own operation key so a retried settle cannot double-charge.
     */
    idempotencyKey: text("idempotency_key"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_account_ledger_tenant_idem").on(t.tenantId, t.idempotencyKey),
    index("credit_account_ledger_tenant_created").on(t.tenantId, t.createdAt),
    index("credit_account_ledger_ref").on(t.refKind, t.refId),
  ],
);

export type CreditAccountLedgerEntry = typeof creditAccountLedgerTable.$inferSelect;
