import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Server-owned retention record for an uncommitted voice sample extracted from
 * a Brand Kit base video. The row is removed when the user cancels or when a
 * successful voice clone adopts the object; expired rows are swept with their
 * private objects even if the browser crashed before sending cleanup.
 */
export const brandVoiceExtractedSamplesTable = pgTable(
  "brand_voice_extracted_samples",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    brandKitId: integer("brand_kit_id").notNull(),
    objectPath: text("object_path").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    objectPathUnique: unique("brand_voice_extracted_samples_object_path_uniq").on(
      t.objectPath,
    ),
    expiresAtIdx: index("brand_voice_extracted_samples_expires_at_idx").on(
      t.expiresAt,
    ),
  }),
);

export type BrandVoiceExtractedSample =
  typeof brandVoiceExtractedSamplesTable.$inferSelect;