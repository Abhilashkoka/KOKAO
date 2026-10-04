import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export interface VideoPublishMetadata {
  destination: "instagram" | "facebook" | "youtube";
  format: "reel" | "video";
  title: string;
  description: string;
  privacy: "public" | "private" | "unlisted";
  madeForKids: boolean;
}

/** A durable, immutable reviewed upload; sensitive resumable URLs are encrypted. */
export const videoPublishesTable = pgTable("video_publishes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  contentItemId: integer("content_item_id").notNull(),
  platform: text("platform").notNull(),
  videoPath: text("video_path").notNull(),
  metadata: jsonb("metadata").$type<VideoPublishMetadata>().notNull(),
  state: text("state").notNull().default("queued"),
  externalId: text("external_id"),
  containerId: text("container_id"),
  encryptedSession: text("encrypted_session"),
  accountId: text("account_id"),
  error: text("error"),
  permalink: text("permalink"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("video_publish_content_platform").on(table.contentItemId, table.platform)]);