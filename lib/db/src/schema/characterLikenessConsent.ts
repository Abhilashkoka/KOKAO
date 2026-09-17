import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * An electronic likeness-rights attestation is an immutable event, not mutable
 * character metadata.  It deliberately stores neither identity documents,
 * contact information, IP addresses, nor provider "approval" claims.
 */
export const characterLikenessConsentGrantsTable = pgTable(
  "character_likeness_consent_grants",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    characterId: integer("character_id").notNull(),
    /** The tenant-owned canonical source at the time of attestation. */
    sourcePath: text("source_path").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceReferenceSource: text("source_reference_source")
      .$type<"uploaded">()
      .notNull(),
    policyVersion: text("policy_version").notNull(),
    statement: text("statement").notNull(),
    /** Stable recipient labels disclosed by the versioned statement. */
    imageProcessorScope: jsonb("image_processor_scope").$type<string[]>().notNull(),
    subject: text("subject").$type<"self" | "authorized_person">().notNull(),
    providers: jsonb("providers").$type<["atlascloud"]>().notNull(),
    imageRightsConfirmed: boolean("image_rights_confirmed").notNull(),
    adultConfirmed: boolean("adult_confirmed").notNull(),
    likenessConfirmed: boolean("likeness_confirmed").notNull(),
    writtenPermissionConfirmed: boolean("written_permission_confirmed").notNull(),
    allowOutfitEdits: boolean("allow_outfit_edits").notNull(),
    allowScriptedSpeech: boolean("allow_scripted_speech").notNull(),
    actingClerkUserId: text("acting_clerk_user_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("character_likeness_consent_grant_character_idx").on(
      table.tenantId,
      table.characterId,
      table.grantedAt,
    ),
    index("character_likeness_consent_grant_source_idx").on(
      table.tenantId,
      table.characterId,
      table.sourcePath,
      table.sourceSha256,
    ),
  ],
);

/** Explicit append-only revocation event. One event makes a grant inactive. */
export const characterLikenessConsentRevocationsTable = pgTable(
  "character_likeness_consent_revocations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    characterId: integer("character_id").notNull(),
    consentId: integer("consent_id").notNull(),
    actingClerkUserId: text("acting_clerk_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("character_likeness_consent_revocation_consent_uniq").on(
      table.consentId,
    ),
    index("character_likeness_consent_revocation_character_idx").on(
      table.tenantId,
      table.characterId,
      table.revokedAt,
    ),
  ],
);

export type CharacterLikenessConsentGrant =
  typeof characterLikenessConsentGrantsTable.$inferSelect;
export type CharacterLikenessConsentRevocation =
  typeof characterLikenessConsentRevocationsTable.$inferSelect;