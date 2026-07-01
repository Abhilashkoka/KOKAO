import {
  pgTable,
  text,
  serial,
  integer,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { BrandKitPayload } from "./brandKitPayload";

/**
 * Immutable snapshot of a brand kit. Every meaningful edit creates a NEW row
 * (never mutate an existing version). `json_payload` is the source of truth for
 * brand design rules. `tenantId` is denormalized here so every read can be
 * tenant-scoped without a join.
 */
export const brandKitVersionsTable = pgTable(
  "brand_kit_versions",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    brandKitId: integer("brand_kit_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    // "manual" | "ai_extraction" | "import"
    sourceType: text("source_type").notNull().default("manual"),
    sourceNotes: text("source_notes"),
    // "draft" | "approved" | "archived"
    approvalStatus: text("approval_status").notNull().default("draft"),
    jsonPayload: jsonb("json_payload").$type<BrandKitPayload>().notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    kitVersionUnique: unique("brand_kit_versions_kit_number_uniq").on(
      t.brandKitId,
      t.versionNumber,
    ),
  }),
);

export type BrandKitVersion = typeof brandKitVersionsTable.$inferSelect;
