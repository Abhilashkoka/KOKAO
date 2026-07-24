import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A campaign is a persistent container with a goal: content items attach to
 * it (content_items.campaign_id), and its report aggregates the post_metrics
 * of everything published under it. This is what turns one-shot generation
 * into a create -> publish -> measure loop.
 */
export const campaignsTable = pgTable(
  "campaigns",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    name: text("name").notNull(),
    // What success means for this campaign: awareness | engagement | traffic |
    // leads | sales | other (free-form allowed, UI offers the presets).
    goal: text("goal").notNull().default("engagement"),
    // Optional numeric target for the goal (e.g. 500 interactions).
    goalTarget: integer("goal_target"),
    description: text("description"),
    // active | completed | archived
    status: text("status").notNull().default("active"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("campaigns_tenant_idx").on(t.tenantId)],
);

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
