import { pgTable, serial, integer, timestamp, text } from "drizzle-orm/pg-core";

/**
 * Single-row (id=1) health record for the background dead-connection sweep.
 * The sweep upserts this row after every completed run so a superadmin can
 * confirm from the admin dashboard that the in-process timer is still alive
 * in production (frequent redeploys or a dead timer would otherwise silently
 * remove the safety net).
 */
export const sweepStatusTable = pgTable("sweep_status", {
  id: serial("id").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  accountsChecked: integer("accounts_checked").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SweepStatus = typeof sweepStatusTable.$inferSelect;
