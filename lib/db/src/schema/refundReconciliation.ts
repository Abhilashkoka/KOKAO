import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/** Canonically confirmed successful refunds; durable accounting retry/manual queue. No PII. */
export const refundReconciliationsTable = pgTable("refund_reconciliations", {
  id: serial("id").primaryKey(),
  gateway: text("gateway").notNull(),
  refundId: text("refund_id").notNull(),
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").notNull(),
  refId: text("ref_id").notNull(),
  refundedPaise: integer("refunded_paise").notNull(),
  purchasePaise: integer("purchase_paise").notNull(),
  status: text("status").notNull().default("pending"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("refund_reconciliations_gateway_refund").on(t.gateway, t.refundId),
  index("refund_reconciliations_purchase").on(t.kind, t.refId),
]);