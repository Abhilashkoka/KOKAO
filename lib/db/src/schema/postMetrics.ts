import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-post engagement metrics pulled back from the platforms a content item
 * was published to. One row per (contentItemId, platform); each background
 * poll overwrites the counters in place (platforms report cumulative totals,
 * so history is not needed — the latest snapshot is the truth).
 *
 * Polling follows a decay schedule driven by nextPollAt: hot for the first
 * 48h after publish, then daily, then stops entirely after 14 days
 * (pollState becomes "done"). A definitive platform rejection (deleted post,
 * revoked token) sets pollState "failed" and stops polling that row.
 */
export const postMetricsTable = pgTable(
  "post_metrics",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    contentItemId: integer("content_item_id").notNull(),
    platform: text("platform").notNull(),
    postId: text("post_id").notNull(),
    likes: integer("likes").notNull().default(0),
    comments: integer("comments").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    // Reach/impressions where the platform exposes it; 0 when unavailable.
    impressions: integer("impressions").notNull().default(0),
    // When the underlying post went live (drives the decay schedule).
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    // Last successful metrics fetch; null until the first poll lands.
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    // Next time the poller should refresh this row; null when polling stopped.
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    // active | done | failed
    pollState: text("poll_state").notNull().default("active"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("post_metrics_item_platform_unique").on(
      t.contentItemId,
      t.platform,
    ),
    index("post_metrics_tenant_idx").on(t.tenantId),
    index("post_metrics_next_poll_idx").on(t.nextPollAt),
  ],
);

export type PostMetricsRow = typeof postMetricsTable.$inferSelect;
export type InsertPostMetrics = typeof postMetricsTable.$inferInsert;
