import { pgTable, text, serial, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/** Only hashes persist. VPA/card identifiers are NOT comparable to bank accounts. */
export const tenantPaymentInstrumentsTable = pgTable("tenant_payment_instruments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").notNull(),
  instrumentHash: text("instrument_hash").notNull(),
  bankAccountHash: text("bank_account_hash"),
  last4: text("last4"),
  gateway: text("gateway").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("tenant_payment_instruments_unique").on(t.tenantId, t.instrumentHash),
  index("tenant_payment_instruments_bank").on(t.bankAccountHash),
]);