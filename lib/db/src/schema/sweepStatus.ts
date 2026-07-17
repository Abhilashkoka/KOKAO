import {
  pgTable,
  serial,
  integer,
  timestamp,
  text,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * One abandoned/failed re-verify from the most recent sweep run, kept so an
 * admin can see WHICH tenant+platform keeps timing out (not just a count).
 */
export interface SweepFailure {
  tenantId: number;
  platform: string;
  error: string;
  /** ISO timestamp of when the failure was recorded. */
  at: string;
  /** How many sweeps in a row this tenant+platform check has failed,
   * including this one. Distinguishes a chronic breakage from a blip. */
  consecutiveFailures?: number;
}

/**
 * Cross-run consecutive-failure tally for one tenant+platform check, keyed
 * `${tenantId}:${platform}` in the fail_streaks map. Incremented each sweep
 * the check fails, removed the first sweep it succeeds (or the account is
 * gone), so a chronically broken credential is distinguishable from noise.
 */
export interface SweepStreak {
  count: number;
  /** ISO timestamp of the first failure in the current streak. */
  firstFailedAt: string;
  lastError: string;
  /** ISO timestamp of the most recent failure. */
  lastAt: string;
}

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
  /** Most recent failed checks (tenant + platform + error), newest first,
   * capped at a handful so a chronically slow provider is identifiable from
   * the admin dashboard without reading server logs. */
  recentFailures: jsonb("recent_failures")
    .$type<SweepFailure[]>()
    .notNull()
    .default([]),
  /** Consecutive-failure tally per tenant+platform (`"tenantId:platform"` ->
   * streak), carried across runs so an admin can tell a check that fails
   * sweep after sweep from a one-off blip. Reset (key removed) on success. */
  failStreaks: jsonb("fail_streaks")
    .$type<Record<string, SweepStreak>>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SweepStatus = typeof sweepStatusTable.$inferSelect;
