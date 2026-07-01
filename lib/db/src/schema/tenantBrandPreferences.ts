import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Maps a use case (optionally scoped by channel + content_type) to a preferred
 * brand kit. Consumed by the brand selection service when a request does not
 * explicitly name a brand. `priority` breaks ties (higher wins).
 */
export const tenantBrandPreferencesTable = pgTable(
  "tenant_brand_preferences",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    useCase: text("use_case"),
    channel: text("channel"),
    contentType: text("content_type"),
    brandKitId: integer("brand_kit_id").notNull(),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export type TenantBrandPreference =
  typeof tenantBrandPreferencesTable.$inferSelect;
