import { pgTable, text, serial, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/** Signed paise. Financial entries are immutable; only their payout claim changes. */
export const creatorLedgerAdjustmentsTable = pgTable("creator_ledger_adjustments", {
  id: serial("id").primaryKey(),
  creatorId: integer("creator_id").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  kind: text("kind").notNull(),
  commissionId: integer("commission_id"),
  payoutId: integer("payout_id"),
  /** Separate from the source payout: this is the batch settling this entry. */
  consumedByPayoutId: integer("consumed_by_payout_id"),
  idempotencyKey: text("idempotency_key"),
  note: text("note"),
  createdByTenantId: integer("created_by_tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("creator_ledger_adjustments_idem").on(t.idempotencyKey),
  index("creator_ledger_adjustments_creator").on(t.creatorId, t.createdAt),
  index("creator_ledger_adjustments_claim").on(t.consumedByPayoutId),
]);
export type CreatorLedgerAdjustment = typeof creatorLedgerAdjustmentsTable.$inferSelect;