import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Snapshot of a LinkedIn overflow-comment sequence that did not fully post.
 * The exact comment texts (already "(i/n)"-numbered) are stored so a later
 * caption edit cannot change the numbering of a resend; postedCount marks how
 * many leading comments already succeeded.
 */
export interface LinkedinCommentState {
  postUrn: string;
  comments: string[];
  postedCount: number;
}

/**
 * Snapshot of a reply-chained thread (Threads or X) that did not fully post.
 * The exact chunk texts are stored so a later caption edit cannot change what
 * a resend posts; postedCount marks how many leading posts already succeeded,
 * and lastPostedId is the reply-to anchor for the next missing post.
 */
export interface ThreadChainState {
  firstPostId: string;
  lastPostedId: string;
  posts: string[];
  postedCount: number;
}

export const contentItemsTable = pgTable("content_items", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  brandKitId: integer("brand_kit_id"),
  title: text("title").notNull(),
  caption: text("caption").notNull().default(""),
  imagePath: text("image_path"),
  imagePrompt: text("image_prompt"),
  platform: text("platform").notNull().default("instagram"),
  // Brand use-case for selection/preferences: social_post | reel | short |
  // ad_creative | landing_page | email
  contentType: text("content_type").notNull().default("social_post"),
  status: text("status").notNull().default("draft"),
  // Human-readable reason a publish failed. Set by the background publisher on
  // a real rejection and by startup recovery when a restart orphaned the item;
  // cleared whenever a new publish attempt starts or the item is published.
  failureReason: text("failure_reason"),
  postId: text("post_id"),
  permalink: text("permalink"),
  // Present only while a LinkedIn overflow-comment sequence is incomplete;
  // cleared when all comments are posted (or a fresh publish starts over).
  linkedinCommentState: jsonb("linkedin_comment_state").$type<LinkedinCommentState>(),
  // Present only while a Threads reply-chain is incomplete; cleared when all
  // posts are published (or a fresh publish starts over).
  threadsChainState: jsonb("threads_chain_state").$type<ThreadChainState>(),
  // Present only while an X thread is incomplete; cleared when all posts are
  // published (or a fresh publish starts over).
  twitterChainState: jsonb("twitter_chain_state").$type<ThreadChainState>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertContentItemSchema = createInsertSchema(contentItemsTable).omit({
  id: true,
  tenantId: true,
  linkedinCommentState: true,
  threadsChainState: true,
  twitterChainState: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContentItem = z.infer<typeof insertContentItemSchema>;
export type ContentItem = typeof contentItemsTable.$inferSelect;
