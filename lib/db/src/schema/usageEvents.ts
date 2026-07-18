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
  // "quota" (default, counts against the plan) or "credit" (prepaid credit;
  // excluded from quota counting but still metered for data consumption).
  funding: text("funding"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUsageEventSchema = createInsertSchema(usageEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUsageEvent = z.infer<typeof insertUsageEventSchema>;
export type UsageEvent = typeof usageEventsTable.$inferSelect;
