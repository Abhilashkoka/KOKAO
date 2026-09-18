import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Subject classes. The class describes WHO the likeness belongs to, which is a
 * fact about the person and the submitting user's authority over them. It is
 * deliberately independent of which provider will process the image: a change
 * of provider does not change who is in the picture.
 */
export type LikenessSubjectClass =
  | "uploaded_self"
  | "uploaded_authorized_person"
  | "generated_fictional";

/** Operations that can send a likeness to a third party. */
export type LikenessRecipientOperation =
  | "reference_sheet"
  | "outfit"
  | "video"
  | "asset_registration";

/**
 * An electronic likeness-rights attestation is an immutable event, not mutable
 * character metadata.  It deliberately stores neither identity documents,
 * contact information, IP addresses, nor provider "approval" claims.
 *
 * The grant records the SUBJECT and the authorized USES only. Recipients live
 * in character_likeness_recipient_disclosures, so adding or changing a provider
 * never invalidates a still-truthful statement about the person depicted.
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
      .$type<"uploaded" | "generated">()
      .notNull(),
    subjectClass: text("subject_class").$type<LikenessSubjectClass>().notNull(),
    policyVersion: text("policy_version").notNull(),
    statement: text("statement").notNull(),
    subject: text("subject").$type<"self" | "authorized_person">().notNull(),
    imageRightsConfirmed: boolean("image_rights_confirmed").notNull(),
    adultConfirmed: boolean("adult_confirmed").notNull(),
    likenessConfirmed: boolean("likeness_confirmed").notNull(),
    writtenPermissionConfirmed: boolean("written_permission_confirmed").notNull(),
    /**
     * Authorized uses. Provider-independent, but NOT use-independent: wardrobe
     * editing, video depiction and scripted speech are separate permissions.
     * Permission to depict someone does not authorize making them speak.
     */
    allowOutfitEdits: boolean("allow_outfit_edits").notNull(),
    allowVideoDepiction: boolean("allow_video_depiction").notNull().default(false),
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

/**
 * Append-only recipient disclosure. One row per (grant, provider, model,
 * operation) the user has been shown and accepted.
 *
 * This is what makes a provider-independent attestation still an INFORMED one:
 * the statement covers the person, this ledger covers who receives them. A new
 * provider therefore needs a cheap acknowledgement rather than a re-signature
 * of the whole attestation, and the user can stop one recipient without
 * destroying an attestation that remains true.
 */
export const characterLikenessRecipientDisclosuresTable = pgTable(
  "character_likeness_recipient_disclosures",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    characterId: integer("character_id").notNull(),
    consentId: integer("consent_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    operation: text("operation").$type<LikenessRecipientOperation>().notNull(),
    /** Stable human label shown to the user when they accepted this recipient. */
    scopeLabel: text("scope_label").notNull(),
    actingClerkUserId: text("acting_clerk_user_id").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("character_likeness_recipient_disclosure_uniq").on(
      table.tenantId,
      table.consentId,
      table.provider,
      table.model,
      table.operation,
    ),
    index("character_likeness_recipient_disclosure_character_idx").on(
      table.tenantId,
      table.characterId,
      table.acknowledgedAt,
    ),
  ],
);

/** Per-recipient withdrawal. Stops future submissions to that one recipient. */
export const characterLikenessRecipientRevocationsTable = pgTable(
  "character_likeness_recipient_revocations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    characterId: integer("character_id").notNull(),
    disclosureId: integer("disclosure_id").notNull(),
    actingClerkUserId: text("acting_clerk_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("character_likeness_recipient_revocation_uniq").on(
      table.disclosureId,
    ),
    index("character_likeness_recipient_revocation_character_idx").on(
      table.tenantId,
      table.characterId,
      table.revokedAt,
    ),
  ],
);

/**
 * Standing tenant declaration covering server-created AI-generated fictional
 * cast, which has no real subject to attest for and no user in the loop at
 * creation time. It is the record that a photorealistic generated face is NOT
 * a real individual — the evidence for the reverse argument when a provider's
 * classifier flags an AI face as a possible real human.
 */
export const tenantLikenessStandingDeclarationsTable = pgTable(
  "tenant_likeness_standing_declarations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    statement: text("statement").notNull(),
    fictionalOnlyConfirmed: boolean("fictional_only_confirmed").notNull(),
    adultConfirmed: boolean("adult_confirmed").notNull(),
    noRealPersonConfirmed: boolean("no_real_person_confirmed").notNull(),
    actingClerkUserId: text("acting_clerk_user_id").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tenant_likeness_standing_declaration_idx").on(
      table.tenantId,
      table.grantedAt,
    ),
  ],
);

export type CharacterLikenessConsentGrant =
  typeof characterLikenessConsentGrantsTable.$inferSelect;
export type CharacterLikenessConsentRevocation =
  typeof characterLikenessConsentRevocationsTable.$inferSelect;
export type CharacterLikenessRecipientDisclosure =
  typeof characterLikenessRecipientDisclosuresTable.$inferSelect;
export type CharacterLikenessRecipientRevocation =
  typeof characterLikenessRecipientRevocationsTable.$inferSelect;
export type TenantLikenessStandingDeclaration =
  typeof tenantLikenessStandingDeclarationsTable.$inferSelect;
