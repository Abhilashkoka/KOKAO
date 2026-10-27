import {
  pgTable,
  serial,
  integer,
  boolean,
  text,
  real,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * AI ERROR GUARANTEE: a user reports that a finished video is wrong in a way
 * the AI caused (product changed, script line missed, wrong person, garbled
 * on-screen text) and gets credits back for the part that is wrong.
 *
 * One claim per video. Objective categories inside the auto-approve limits are
 * refunded straight away; everything else waits in the admin queue. The
 * refund itself is an ordinary credit-ledger `refund` row (idempotency key
 * `ai-error-claim:<id>`), so balances, receipts and history stay in one place.
 */
export const aiErrorClaimsTable = pgTable(
  "ai_error_claims",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    jobId: integer("job_id").notNull(),
    /** Smart Edit version the user was watching ("v0" = original). */
    versionId: text("version_id").notNull().default("v0"),
    /** product_changed | script_missed | wrong_person | garbled_text | other */
    category: text("category").notNull(),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    /** Length of the video the range was marked on. */
    videoDurationSec: real("video_duration_sec").notNull(),
    note: text("note").notNull().default(""),
    /** pending | approved | rejected */
    status: text("status").notNull().default("pending"),
    /** True when the guarantee rules approved it without a person. */
    autoApproved: boolean("auto_approved").notNull().default(false),
    /** What the share-of-video rule offers, at claim time. */
    suggestedCredits: real("suggested_credits").notNull().default(0),
    creditsRefunded: real("credits_refunded").notNull().default(0),
    decidedByTenantId: integer("decided_by_tenant_id"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    // One claim per video, ever: a rejected claim cannot be refiled to fish
    // for a different reviewer.
    uniqueIndex("ai_error_claims_tenant_job").on(t.tenantId, t.jobId),
    index("ai_error_claims_status_created").on(t.status, t.createdAt),
    index("ai_error_claims_tenant_created").on(t.tenantId, t.createdAt),
  ],
);

export type AiErrorClaim = typeof aiErrorClaimsTable.$inferSelect;

/**
 * Guarantee settings, one row (id = 1). Missing row = defaults, with the
 * guarantee OFF: it changes the terms of sale, so it is switched on only
 * after the terms clause is signed off.
 */
export const aiErrorGuaranteeSettingsTable = pgTable("ai_error_guarantee_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** Days after a video is created during which it can be claimed. */
  claimWindowDays: integer("claim_window_days").notNull().default(7),
  /** Auto-approved claims per workspace per calendar month (UTC). */
  autoApprovePerMonth: integer("auto_approve_per_month").notNull().default(2),
  /** A marked range above this share of the video goes to a person. */
  autoApproveMaxPercent: integer("auto_approve_max_percent").notNull().default(50),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
