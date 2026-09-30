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
 * Hashed payment instruments, per workspace.
 *
 * This is the missing half of the strongest anti-fraud signal in the promoter
 * programme: the same UPI VPA or bank account paying IN for credits and
 * receiving OUT as commission is one person on both sides of the trade.
 * `bankMatchesOwnReferrals()` in creatorPayouts.ts is already wired to ask the
 * question — it just had nothing to ask.
 *
 * PII: only HMAC hashes and a last-4 are stored, using the same
 * CREATOR_PII_PEPPER as payout identities, so the two sides are comparable.
 * Raw VPAs and card numbers are never persisted.
 */
export const tenantPaymentInstrumentsTable = pgTable(
  "tenant_payment_instruments",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** upi | card | netbanking | other */
    kind: text("kind").notNull(),
    /**
     * HMAC of the normalized instrument identity.
     *   upi  — the VPA, lowercased
     *   card — the gateway's card fingerprint, or `network|last4|issuer`
     * Hashed with the SAME pepper and scheme as creator_payout_identities so a
     * payout destination can be compared against it directly.
     */
    instrumentHash: text("instrument_hash").notNull(),
    /**
     * For UPI, the bank-account form of the same identity where the gateway
     * supplies it — `hashPii(`${account}|${ifsc}`)` — so it can be compared to
     * a payout bankAccountHash without a format mismatch. Null when unknown.
     */
    bankAccountHash: text("bank_account_hash"),
    last4: text("last4"),
    issuer: text("issuer"),
    gateway: text("gateway"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    useCount: integer("use_count").notNull().default(1),
  },
  (t) => [
    uniqueIndex("tenant_payment_instruments_unique").on(
      t.tenantId,
      t.instrumentHash,
    ),
    /** The lookup the fraud check performs. */
    index("tenant_payment_instruments_hash").on(t.instrumentHash),
    index("tenant_payment_instruments_bank").on(t.bankAccountHash),
  ],
);

export type TenantPaymentInstrument =
  typeof tenantPaymentInstrumentsTable.$inferSelect;
