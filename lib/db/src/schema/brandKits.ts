import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brandKitsTable = pgTable("brand_kits", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  primaryColor: text("primary_color").notNull().default("#6366f1"),
  secondaryColor: text("secondary_color").notNull().default("#0ea5e9"),
  accentColor: text("accent_color").notNull().default("#f59e0b"),
  voice: text("voice").notNull().default(""),
  hashtags: text("hashtags").array().notNull().default([]),
  logoPath: text("logo_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertBrandKitSchema = createInsertSchema(brandKitsTable).omit({
  id: true,
  tenantId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBrandKit = z.infer<typeof insertBrandKitSchema>;
export type BrandKit = typeof brandKitsTable.$inferSelect;
