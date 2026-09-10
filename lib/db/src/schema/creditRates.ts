import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * The CREDIT RATE CARD: how many credits one unit of each billable action
 * costs. This is the single place a superadmin sets pricing for everything
 * KOKAO spends money on — a caption, an image, a second of video, a second of
 * voice, a second of lip sync, and whatever comes next.
 *
 * It replaces the three hardcoded rates buried in `estimateChargePaise()` with
 * data, so adding a new cost centre is a row, not a deploy.
 *
 * Amounts are MILLI-CREDITS (thousandths of a credit) held as integers, for
 * the same reason money is held in paise: a caption that should cost a fifth
 * of a credit must not become a float. 1000 milli-credits = 1 credit.
 *
 * The anchor the whole card is calibrated against: 1 credit = 1 second of
 * finished standard-resolution video, so `video` sits at 1000 and every other
 * row is priced relative to it.
 */
export const creditRatesTable = pgTable("credit_rates", {
  id: serial("id").primaryKey(),
  /**
   * Stable lookup key used by the meter at the provider boundary, e.g.
   * "image", "caption", "video", "voice", "lipsync". Never renamed once live —
   * historical meter events reference it.
   */
  key: text("key").notNull().unique(),
  /** Human label for the admin table, e.g. "Video generation". */
  label: text("label").notNull(),
  /**
   * What one unit is: "item" (per image, per caption) or "second" (per second
   * of video, voice or lip sync). Drives how the admin card labels the rate
   * and how the meter converts a quantity.
   */
  unit: text("unit").notNull().default("item"),
  /** Credits per unit, in thousandths. 1000 = one credit per unit. */
  creditsMilli: integer("credits_milli").notNull().default(0),
  /**
   * Off means the meter records the call at zero credits rather than skipping
   * it, so a deliberately free action still shows up in the cost report.
   */
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Admin-facing note, e.g. which provider or model this rate assumes. */
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CreditRate = typeof creditRatesTable.$inferSelect;

/**
 * Platform-wide meter switch. Single row, superadmin-managed.
 *
 * "off"     — the meter is a pass-through; nothing is recorded.
 * "shadow"  — every provider call is recorded at its rate-card price, and
 *             NOTHING is charged. This is the mode to launch in: it produces
 *             the first true per-job cost picture (retries and failed renders
 *             included) with zero risk to a live workspace.
 * "enforce"  — the same, and the credits are actually debited from the
 *             workspace balance before the provider call, refunded if it
 *             fails.
 *
 * Going straight to "enforce" charges from a rate card nobody has checked
 * against a provider invoice. Run "shadow" first, reconcile, then switch.
 */
export const creditMeterSettingsTable = pgTable("credit_meter_settings", {
  id: serial("id").primaryKey(),
  /** "off" | "shadow" | "enforce" */
  mode: text("mode").notNull().default("shadow"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CreditMeterSettings = typeof creditMeterSettingsTable.$inferSelect;

/**
 * Append-only record of every metered provider call.
 *
 * This is the table that answers "where did the money go". Unlike
 * `usage_events`, which only records SUCCESSFUL, user-facing generations, a
 * row lands here for every provider call the meter wraps — including the scene
 * keyframes generated inside a video job, the retry after one of them fails,
 * and the render a QA gate later rejects. Those are the calls a provider bills
 * and nothing else in the app counts.
 */
export const creditMeterEventsTable = pgTable(
  "credit_meter_events",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** Matches `credit_rates.key` at the time of the call. */
    rateKey: text("rate_key").notNull(),
    /**
     * How much was consumed, in thousandths of a unit: 22450 = 22.45 seconds
     * of video, or 1000 = one image. Thousandths so a fractional duration
     * survives without a float.
     */
    quantityMilli: integer("quantity_milli").notNull(),
    /** quantityMilli x the rate, rounded — what this call would cost. */
    creditsMilli: integer("credits_milli").notNull(),
    /** "ok" when the provider call returned, "failed" when it threw. */
    outcome: text("outcome").notNull(),
    /** The meter mode in force when the row was written. */
    mode: text("mode").notNull(),
    provider: text("provider"),
    model: text("model"),
    /** What this call was for: videoJob | imageJob | content | campaign. */
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    /**
     * What the PROVIDER said this call cost, when it says anything.
     *
     * Atlas bills Seedance by output token, not by second, and the token count
     * for one clip swings by an order of magnitude with resolution — which is
     * invisible if you only record duration. Storing the provider's own
     * figures beside the rate-card price is what makes the two reconcilable
     * against an invoice instead of merely plausible.
     */
    providerTokens: integer("provider_tokens"),
    /** Provider-reported cost in MICRO-dollars (USD * 1e6), when reported. */
    providerCostMicroUsd: integer("provider_cost_micro_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_meter_events_tenant_created").on(t.tenantId, t.createdAt),
    index("credit_meter_events_ref").on(t.refKind, t.refId),
    index("credit_meter_events_key_created").on(t.rateKey, t.createdAt),
  ],
);

export type CreditMeterEvent = typeof creditMeterEventsTable.$inferSelect;
