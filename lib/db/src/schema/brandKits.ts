import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A brand profile under a tenant. This is a POINTER + METADATA table only —
 * the actual brand design rules live in versioned JSON on `brand_kit_versions`.
 * `activeVersionId` points at the live version a tenant has approved/activated.
 */
export const brandKitsTable = pgTable(
  "brand_kits",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // "primary" | "sub_brand"
    brandType: text("brand_type").notNull().default("primary"),
    // "draft" | "active" (archived tracked separately via isArchived)
    status: text("status").notNull().default("draft"),
    isDefault: boolean("is_default").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    createdBy: text("created_by"),
    activeVersionId: integer("active_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tenantSlugUnique: unique("brand_kits_tenant_slug_uniq").on(
      t.tenantId,
      t.slug,
    ),
  }),
);

export const insertBrandKitSchema = createInsertSchema(brandKitsTable).omit({
  id: true,
  tenantId: true,
  activeVersionId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBrandKit = z.infer<typeof insertBrandKitSchema>;
export type BrandKit = typeof brandKitsTable.$inferSelect;
