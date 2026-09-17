import {
  characterLikenessConsentGrantsTable,
  characterLikenessConsentRevocationsTable,
  charactersTable,
  db,
  type Character,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { isPersonalLikenessSource } from "./provenancePolicy";

export interface FrozenPersonalLikenessGrant {
  consentId: number;
  sourcePath: string;
  sourceSha256: string;
  policyVersion: string;
  imageProcessorScope: string[];
}

export class PersonalLikenessConsentError extends Error {}

/** Server-side substantive checks intentionally live beside the data boundary,
 * rather than treating checkbox-shaped JSON as authority. */
export function validateLikenessGrantAttestation(input: {
  subject: "self" | "authorized_person";
  imageRightsConfirmed: boolean;
  adultConfirmed: boolean;
  likenessConfirmed: boolean;
  writtenPermissionConfirmed: boolean;
}): string | null {
  if (
    !input.imageRightsConfirmed ||
    !input.adultConfirmed ||
    !input.likenessConfirmed ||
    (input.subject === "authorized_person" && !input.writtenPermissionConfirmed)
  ) {
    return "All required likeness-rights attestations must be confirmed.";
  }
  return null;
}

const likenessGrantRequestKeys = new Set([
  "sourceSha256",
  "policyVersion",
  "subject",
  "imageRightsConfirmed",
  "adultConfirmed",
  "likenessConfirmed",
  "writtenPermissionConfirmed",
  "allowOutfitEdits",
  "allowScriptedSpeech",
  "providers",
]);
const likenessRevocationRequestKeys = new Set(["consentId"]);

/** Generated Zod clients strip unknown object keys by default; routes must
 * reject them so callers cannot smuggle actor/proof/provider fields. */
export function hasOnlyLikenessConsentRequestKeys(
  body: unknown,
  kind: "grant" | "revoke",
): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const allowed = kind === "grant"
    ? likenessGrantRequestKeys
    : likenessRevocationRequestKeys;
  return Object.keys(body).every((key) => allowed.has(key));
}

async function latestGrant(tenantId: number, characterId: number) {
  return (
    await db
      .select()
      .from(characterLikenessConsentGrantsTable)
      .where(and(
        eq(characterLikenessConsentGrantsTable.tenantId, tenantId),
        eq(characterLikenessConsentGrantsTable.characterId, characterId),
      ))
      .orderBy(
        desc(characterLikenessConsentGrantsTable.grantedAt),
        desc(characterLikenessConsentGrantsTable.id),
      )
      .limit(1)
  )[0] ?? null;
}

async function isRevoked(tenantId: number, characterId: number, consentId: number) {
  return Boolean(
    (
      await db.select({ id: characterLikenessConsentRevocationsTable.id })
        .from(characterLikenessConsentRevocationsTable)
        .where(and(
          eq(characterLikenessConsentRevocationsTable.tenantId, tenantId),
          eq(characterLikenessConsentRevocationsTable.characterId, characterId),
          eq(characterLikenessConsentRevocationsTable.consentId, consentId),
        ))
        .limit(1)
    )[0],
  );
}

/**
 * Freeze an uploaded personal source's exact grant before funding. Generated
 * and unknown sources are deliberately not reclassified by this feature.
 */
export async function freezePersonalImageConsent(input: {
  tenantId: number;
  character: Character;
  sourceSha256: string;
  imageProcessorScope: readonly string[];
  policyVersion: string;
}): Promise<FrozenPersonalLikenessGrant | null> {
  if (!isPersonalLikenessSource(input.character)) return null;
  const grant = await latestGrant(input.tenantId, input.character.id);
  if (
    !grant ||
    !grant.allowOutfitEdits ||
    grant.sourcePath !== input.character.referenceImagePath ||
    grant.sourceSha256 !== input.sourceSha256 ||
    grant.policyVersion !== input.policyVersion ||
    JSON.stringify(grant.imageProcessorScope) !== JSON.stringify(input.imageProcessorScope) ||
    await isRevoked(input.tenantId, input.character.id, grant.id)
  ) {
    throw new PersonalLikenessConsentError(
      "A current unrevoked personal likeness attestation with outfit-edit scope is required before an image provider can receive this source.",
    );
  }
  return {
    consentId: grant.id,
    sourcePath: grant.sourcePath,
    sourceSha256: grant.sourceSha256,
    policyVersion: grant.policyVersion,
    imageProcessorScope: grant.imageProcessorScope,
  };
}

/** Recheck live ownership, exact bytes, scope, and revocation before every provider attempt. */
export async function assertFrozenPersonalImageConsent(input: {
  tenantId: number;
  characterId: number;
  frozen: FrozenPersonalLikenessGrant | null;
  sourceSha256: string;
  processor: string;
}): Promise<void> {
  if (!input.frozen) return;
  if (!input.frozen.imageProcessorScope.includes(input.processor)) {
    throw new PersonalLikenessConsentError(
      "The configured image processor is not covered by the frozen personal likeness attestation.",
    );
  }
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, input.characterId),
    eq(charactersTable.tenantId, input.tenantId),
  )).limit(1);
  const grant = await latestGrant(input.tenantId, input.characterId);
  if (
    !character ||
    !isPersonalLikenessSource(character) ||
    character.referenceImagePath !== input.frozen.sourcePath ||
    input.frozen.sourceSha256 !== input.sourceSha256 ||
    !grant ||
    grant.id !== input.frozen.consentId ||
    grant.sourcePath !== input.frozen.sourcePath ||
    grant.sourceSha256 !== input.frozen.sourceSha256 ||
    !grant.allowOutfitEdits ||
    await isRevoked(input.tenantId, input.characterId, grant.id)
  ) {
    throw new PersonalLikenessConsentError(
      "The frozen personal likeness attestation is no longer current. No image provider submission was made.",
    );
  }
}