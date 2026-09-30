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
 * Promoter ledger adjustments — the escape hatch for money that has already
 * left, or is about to.
 *
 * A commission reversed while still `pending`/`payable` simply changes state;
 * nothing needs recording here. But a refund on a commission that was already
 * PAID cannot un-send a bank transfer, so it lands here as a negative
 * adjustment. It is absorbed by the promoter's reserve first, and whatever is
 * left carries as a negative balance that reduces (and can block) future
 * payouts.
 *
 * Append-only. Amounts are signed PAISE — negative is owed back to KOKAO.
 */
export const creatorLedgerAdjustmentsTable = pgTable(
  "creator_ledger_adjustments",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull(),
    /** Signed paise. Negative = clawback, positive = goodwill/correction. */
    amountPaise: integer("amount_paise").notNull(),
    /** clawback | reserve_release | correction | goodwill */
    kind: text("kind").notNull(),
    /** The commission this reverses, when it is one. */
    commissionId: integer("commission_id"),
    /** The payout the clawed-back money went out in. */
    payoutId: integer("payout_id"),
    /**
     * Makes an adjustment idempotent. A refund webhook redelivered twice must
     * not claw back twice: `clawback:<commissionId>`,
     * `reserve-release:<payoutId>`.
     */
    idempotencyKey: text("idempotency_key"),
    note: text("note"),
    createdByTenantId: integer("created_by_tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("creator_ledger_adjustments_idem").on(t.idempotencyKey),
    index("creator_ledger_adjustments_creator").on(t.creatorId, t.createdAt),
  ],
);

export type CreatorLedgerAdjustment =
  typeof creatorLedgerAdjustmentsTable.$inferSelect;
