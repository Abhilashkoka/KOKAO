import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const contentItemsTable = pgTable("content_items", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  brandKitId: integer("brand_kit_id"),
  title: text("title").notNull(),
  caption: text("caption").notNull().default(""),
  imagePath: text("image_path"),
  imagePrompt: text("image_prompt"),
  platform: text("platform").notNull().default("instagram"),
  status: text("status").notNull().default("draft"),
  postId: text("post_id"),
  permalink: text("permalink"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertContentItemSchema = createInsertSchema(contentItemsTable).omit({
  id: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContentItem = z.infer<typeof insertContentItemSchema>;
export type ContentItem = typeof contentItemsTable.$inferSelect;
