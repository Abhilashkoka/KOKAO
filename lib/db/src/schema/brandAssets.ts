import {
  pgTable,
  text,
  serial,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Raw uploaded brand inputs (logos, PDFs, screenshots, decks, references).
 * Kept SEPARATE from the parsed brand JSON so AI extraction can be re-run later
 * against the original assets without losing them.
 */
export const brandAssetsTable = pgTable("brand_assets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  brandKitId: integer("brand_kit_id").notNull(),
  // "logo" | "pdf" | "screenshot" | "deck" | "reference" | "other"
  assetType: text("asset_type").notNull().default("other"),
  // Object-storage path of the form /objects/...
  fileUrl: text("file_url").notNull(),
  mimeType: text("mime_type"),
  label: text("label"),
  metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BrandAsset = typeof brandAssetsTable.$inferSelect;
