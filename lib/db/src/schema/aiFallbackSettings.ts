import { jsonb, pgTable, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Optional administrator ordering for AI failover families. Absence is
 * meaningful: it retains the historical scorer/catalog ordering.
 */
export const aiFallbackSettingsTable = pgTable("ai_fallback_settings", {
  id: integer("id").primaryKey().default(1),
  orders: jsonb("orders").$type<Record<string, string[]>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AiFallbackSettings = typeof aiFallbackSettingsTable.$inferSelect;