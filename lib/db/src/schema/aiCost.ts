import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Admin-maintained catalog of provider model prices used to compute the
 * ACTUAL money cost of each AI generation (superadmin-only reporting; the
 * tenant-facing "AI amount spent" display uses ai_spend_settings instead).
 *
 * Provider prices are quoted in USD:
 *   - text models: USD per MILLION input tokens / per MILLION output tokens
 *   - image models: USD per generated image
 *   - video models: USD per second of output video and/or USD per video
 * Unknown models (no matching row) yield a NULL cost on the usage event —
 * never a guessed number.
 */
export const aiModelPricesTable = pgTable(
  "ai_model_prices",
  {
    id: serial("id").primaryKey(),
    /** "text", "image", "video", or "audio". */
    kind: text("kind").notNull(),
    /** Provider id, e.g. "builtin", "openrouter", "gemini", "bfl". */
    provider: text("provider").notNull(),
    /** Model name exactly as recorded on usage events. */
    model: text("model").notNull(),
    /** Text models: USD per 1M input tokens. */
    inputUsdPerMtok: doublePrecision("input_usd_per_mtok"),
    /** Text models: USD per 1M output tokens. */
    outputUsdPerMtok: doublePrecision("output_usd_per_mtok"),
    /** Image models: USD per generated image. */
    usdPerImage: doublePrecision("usd_per_image"),
    /** Video models: USD per second of output video. */
    usdPerSecond: doublePrecision("usd_per_second"),
    /** Video models: flat USD per generated video. */
    usdPerVideo: doublePrecision("usd_per_video"),
    /** Audio TTS: USD per generated input character. */
    inputUsdPerCharacter: doublePrecision("input_usd_per_character"),
    /** Audio voice clone: flat USD charged for a successful clone. */
    usdPerSuccessfulClone: doublePrecision("usd_per_successful_clone"),
    /** Audio voice clone: USD per submitted reference-sample second. */
    usdPerSubmittedSampleSecond: doublePrecision("usd_per_submitted_sample_second"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("ai_model_prices_kind_provider_model").on(t.kind, t.provider, t.model)],
);

/**
 * Singleton settings row for actual-cost computation. The USD→INR conversion
 * rate is admin-set (paise per 1 USD, e.g. 8800 = ₹88.00). A rate of 0 means
 * "not configured" and every computed cost stays NULL/unknown.
 */
export const aiCostSettingsTable = pgTable("ai_cost_settings", {
  id: serial("id").primaryKey(),
  /** Paise per 1 USD (0 = unset; costs stay unknown). */
  usdToInrPaise: integer("usd_to_inr_paise").notNull().default(0),
  /** Markup added on top of the fetched market rate on each auto-refresh,
   * in paise (default ₹2.00). */
  rateMarkupPaise: integer("rate_markup_paise").notNull().default(200),
  /** The raw market rate (paise per 1 USD) from the last successful
   * auto-refresh; null until the first refresh succeeds. */
  marketRatePaise: integer("market_rate_paise"),
  /** When the rate was last auto-refreshed successfully; null = never. */
  rateAutoUpdatedAt: timestamp("rate_auto_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AiModelPrice = typeof aiModelPricesTable.$inferSelect;
export type AiCostSettings = typeof aiCostSettingsTable.$inferSelect;
