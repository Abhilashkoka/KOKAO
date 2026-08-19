import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usageEventsTable = pgTable("usage_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  kind: text("kind").notNull(),
  // AI data-consumption metering (nullable — rows predating metering, and
  // usage kinds where sizes don't apply, leave these unset).
  requestBytes: integer("request_bytes"),
  responseBytes: integer("response_bytes"),
  durationMs: integer("duration_ms"),
  model: text("model"),
  // Groups the per-platform rows of one campaign generation (and the image
  // generations triggered from it) under a shared id.
  campaignId: text("campaign_id"),
  platform: text("platform"),
  // "quota" (default, counts against the plan), "credit"/"wallet" (prepaid
  // funding), or "unmetered" (telemetry only). Every value except "quota" is
  // excluded from monthly quota counting.
  funding: text("funding"),
  // Actual-cost tracking (superadmin-only reporting; all nullable and
  // best-effort — rows predating cost tracking, unknown models, or a
  // disabled tracking switch leave these unset).
  provider: text("provider"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  // Computed real cost in PAISE; NULL = unknown (never a guessed number).
  costPaise: integer("cost_paise"),
  // Richer generation telemetry (all nullable and best-effort; a provider that
  // does not report a figure leaves it NULL rather than storing a zero that
  // would read as "measured, and it was none").
  //
  // Subsets of input_tokens / output_tokens respectively, not additions to
  // them: cached_input_tokens are prompt tokens the provider served from its
  // own cache, reasoning_tokens are thinking tokens billed inside the
  // completion. Splitting them out is what makes a cost figure explainable.
  cachedInputTokens: integer("cached_input_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  // Time to first token, streaming text only. The number a tenant actually
  // experiences as "did it hang?", which duration_ms cannot show.
  ttftMs: integer("ttft_ms"),
  // Which link in the fallback chain served this: 0 = the first choice, 1 = the
  // first fallback, and so on. NULL = the path does not fall back.
  fallbackStep: integer("fallback_step"),
  // Short human-readable "why this provider won" for the routed choice.
  // Debugging and cost governance; never parsed.
  routingReason: text("routing_reason"),
  // Tenant-facing display amount in PAISE snapshotted at record time (per-unit
  // rate with fee folded in, at the rates in effect when the event happened).
  // NULL = row predates snapshotting; reports fall back to current rates.
  displayPaise: integer("display_paise"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUsageEventSchema = createInsertSchema(usageEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUsageEvent = z.infer<typeof insertUsageEventSchema>;
export type UsageEvent = typeof usageEventsTable.$inferSelect;
