import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Tax invoices issued to tenants for real money payments (wallet top-ups,
 * credit-pack purchases, plan subscriptions/renewals).
 *
 * Invoices are created ONLY after a payment reaches its verified terminal
 * PAID state (canonical gateway re-fetch), and creation is idempotent on
 * (kind, refId) so verify routes and webhook backstops can both attempt it.
 * Amounts are integers in PAISE. Seller and buyer details are SNAPSHOTTED
 * onto the row at issue time — later edits to settings or the tenant's
 * billing profile never rewrite a past invoice.
 */
export const invoicesTable = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** Sequential human number, e.g. "AE/2026-27/0001". Unique forever. */
    invoiceNumber: text("invoice_number").notNull(),
    /** wallet_topup | credit_pack | plan */
    kind: text("kind").notNull(),
    /** Gateway order/subscription reference this invoice bills (idempotency key with kind). */
    refId: text("ref_id").notNull(),
    /** razorpay | cashfree */
    gateway: text("gateway").notNull(),
    /** One-line description, e.g. "Wallet top-up" or "Growth plan — monthly". */
    description: text("description").notNull(),
    /** GST-exclusive amount. When no GST split exists, equals totalPaise. */
    baseAmountPaise: integer("base_amount_paise").notNull(),
    gstAmountPaise: integer("gst_amount_paise").notNull().default(0),
    /** Whole-number GST percentage; 0 means tax-inclusive/no split known. */
    gstPercent: integer("gst_percent").notNull().default(0),
    totalPaise: integer("total_paise").notNull(),
    currency: text("currency").notNull().default("INR"),
    /** { legalName, gstin?, address? } as configured when issued. */
    seller: jsonb("seller").$type<InvoiceParty>().notNull(),
    /** { legalName, gstin?, address? } from the tenant's billing profile. */
    buyer: jsonb("buyer").$type<InvoiceParty>().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_kind_ref_unique").on(t.kind, t.refId),
    uniqueIndex("invoices_number_unique").on(t.invoiceNumber),
    index("invoices_tenant_issued").on(t.tenantId, t.issuedAt),
  ],
);

export interface InvoiceParty {
  legalName: string;
  gstin?: string | null;
  address?: string | null;
}

export type InvoiceRow = typeof invoicesTable.$inferSelect;

/**
 * Singleton seller settings + the invoice number counter. Superadmin-managed.
 * The counter row is locked FOR UPDATE while issuing so numbers are gapless
 * per financial year and never duplicated under concurrency.
 */
export const invoiceSettingsTable = pgTable(
  "invoice_settings",
  {
    id: serial("id").primaryKey(),
    /** Always true — unique index makes the table a hard DB-level singleton. */
    singleton: boolean("singleton").notNull().default(true),
  legalName: text("legal_name").notNull().default("Asmi Enterprises"),
  gstin: text("gstin"),
  address: text("address"),
  /** Short prefix used in invoice numbers, e.g. "AE". */
  numberPrefix: text("number_prefix").notNull().default("AE"),
  /** Indian financial year label the counter belongs to, e.g. "2026-27". */
  counterFy: text("counter_fy").notNull().default(""),
  /** Next sequence number within counterFy. Resets to 1 on FY rollover. */
  nextSeq: integer("next_seq").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("invoice_settings_singleton").on(t.singleton)],
);

export type InvoiceSettings = typeof invoiceSettingsTable.$inferSelect;

/**
 * Per-tenant buyer details shown on invoices. Optional — invoices fall back
 * to the workspace name when absent. Owner-editable, session-scoped.
 */
export const billingProfilesTable = pgTable("billing_profiles", {
  tenantId: integer("tenant_id").primaryKey(),
  businessName: text("business_name"),
  gstin: text("gstin"),
  address: text("address"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type BillingProfile = typeof billingProfilesTable.$inferSelect;
