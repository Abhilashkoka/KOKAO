import { pgTable, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";

/**
 * GOODWILL: free fixes KOKAO pays for so users never pay for the AI's
 * mistakes.
 *
 * One singleton row (id = 1). Every free fix is still metered at its real
 * provider cost; goodwill only decides that the customer is credited back for
 * it. The credits themselves are written to `credit_account_ledger` with kind
 * `goodwill`, so the ledger stays the single source of truth for budgets,
 * reports and receipts.
 *
 * Missing row = the built-in defaults (on, 1 free image redo per video, 3
 * free Smart Edit seconds, 50 goodwill credits per workspace per month, alarm
 * at 500 goodwill credits a day).
 */
export const goodwillSettingsTable = pgTable("goodwill_settings", {
  id: integer("id").primaryKey(),
  /** Kill switch. Off = every fix is charged normally. */
  enabled: boolean("enabled").notNull().default(true),
  /** Free storyboard image redos per video (0 = none). */
  freeImageRedosPerVideo: integer("free_image_redos_per_video").notNull().default(1),
  /** Free seconds on the first picture Smart Edit of a video (0 = none). */
  freeSmartEditSeconds: integer("free_smart_edit_seconds").notNull().default(3),
  /** Goodwill credits one workspace can receive per calendar month (UTC). */
  monthlyBudgetCredits: integer("monthly_budget_credits").notNull().default(50),
  /** Platform-wide goodwill credits per UTC day that alert superadmins. 0 = off. */
  dailyAlarmCredits: integer("daily_alarm_credits").notNull().default(500),
  /** UTC date (YYYY-MM-DD) the alarm last fired, so it fires once a day. */
  lastAlarmDate: text("last_alarm_date"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GoodwillSettingsRow = typeof goodwillSettingsTable.$inferSelect;
