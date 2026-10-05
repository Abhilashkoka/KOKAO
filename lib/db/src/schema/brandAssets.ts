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
  // "logo" | "pdf" | "screenshot" | "deck" | "reference" | "product" | "other"
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

/**
 * A Brand Kit "Products & Services" entry is a brand_assets row with
 * assetType "product"; its catalog fields live in metadataJson so the raw
 * upload stays re-analysable like every other brand input.
 */
export type BrandProductKind = "product" | "service";
export type BrandProductDisplayMode = "in_scene" | "exact";
export interface BrandProductMetadata {
  version: 1;
  name: string;
  kind: BrandProductKind;
  /** User-written: what it is and the benefit to promote. */
  description: string;
  /** How Guided Story shows it: redrawn in the scene or the untouched upload as a card. */
  displayMode: BrandProductDisplayMode;
  /** One-time AI look of the uploaded image; null until described. */
  aiDescription: string | null;
  aiDescriptionStatus: "pending" | "ready" | "failed";
  aiDescriptionError?: string | null;
  aiDescribedAt: string | null;
  /** SHA-256 of the exact bytes the AI description was made from. */
  imageSha256: string | null;
}
