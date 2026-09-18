import {
  characterLikenessConsentGrantsTable,
  characterLikenessConsentRevocationsTable,
  characterLikenessRecipientDisclosuresTable,
  characterLikenessRecipientRevocationsTable,
  charactersTable,
  db,
  tenantLikenessStandingDeclarationsTable,
  type Character,
  type CharacterLikenessConsentGrant,
  type CharacterLikenessRecipientDisclosure,
  type LikenessRecipientOperation,
  type LikenessSubjectClass,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  isPersonalLikenessSource,
  requiresPerCharacterAttestation,
  requiresStandingDeclaration,
  routingSubjectClassFor,
  standingDeclarationEnforced,
} from "./provenancePolicy";
import {
  resolveLikenessRouting,
  type LikenessSurface,
} from "./likenessProviderPolicy";

export interface FrozenPersonalLikenessGrant {
  consentId: number;
  sourcePath: string;
  sourceSha256: string;
  policyVersion: string;
  subjectClass: LikenessSubjectClass;
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
  "allowVideoDepiction",
  "allowScriptedSpeech",
]);
const likenessRevocationRequestKeys = new Set(["consentId"]);
const likenessRecipientRequestKeys = new Set([
  "consentId",
  "provider",
  "model",
  "operation",
]);

/** Generated Zod clients strip unknown object keys by default; routes must
 * reject them so callers cannot smuggle actor/proof/provider fields.
 *
 * "providers" is deliberately no longer accepted on a grant: a recipient is
 * never something the caller asserts as part of the attestation body. */
export function hasOnlyLikenessConsentRequestKeys(
  body: unknown,
  kind: "grant" | "revoke" | "recipient",
): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const allowed = kind === "grant"
    ? likenessGrantRequestKeys
    : kind === "revoke"
      ? likenessRevocationRequestKeys
      : likenessRecipientRequestKeys;
  return Object.keys(body).every((key) => allowed.has(key));
}

export async function latestGrant(
  tenantId: number,
  characterId: number,
): Promise<CharacterLikenessConsentGrant | null> {
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

export async function isGrantRevoked(
  tenantId: number,
  characterId: number,
  consentId: number,
): Promise<boolean> {
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

export async function latestStandingDeclaration(tenantId: number) {
  return (
    await db
      .select()
      .from(tenantLikenessStandingDeclarationsTable)
      .where(eq(tenantLikenessStandingDeclarationsTable.tenantId, tenantId))
      .orderBy(
        desc(tenantLikenessStandingDeclarationsTable.grantedAt),
        desc(tenantLikenessStandingDeclarationsTable.id),
      )
      .limit(1)
  )[0] ?? null;
}

/** Live, unrevoked disclosure for exactly this recipient tuple, or null. */
export async function activeRecipientDisclosure(input: {
  tenantId: number;
  consentId: number;
  provider: string;
  model: string;
  operation: LikenessRecipientOperation;
}): Promise<CharacterLikenessRecipientDisclosure | null> {
  const rows = await db
    .select({ disclosure: characterLikenessRecipientDisclosuresTable })
    .from(characterLikenessRecipientDisclosuresTable)
    .leftJoin(
      characterLikenessRecipientRevocationsTable,
      eq(
        characterLikenessRecipientRevocationsTable.disclosureId,
        characterLikenessRecipientDisclosuresTable.id,
      ),
    )
    .where(and(
      eq(characterLikenessRecipientDisclosuresTable.tenantId, input.tenantId),
      eq(characterLikenessRecipientDisclosuresTable.consentId, input.consentId),
      eq(characterLikenessRecipientDisclosuresTable.provider, input.provider),
      eq(characterLikenessRecipientDisclosuresTable.model, input.model),
      eq(characterLikenessRecipientDisclosuresTable.operation, input.operation),
      isNull(characterLikenessRecipientRevocationsTable.id),
    ))
    .limit(1);
  return rows[0]?.disclosure ?? null;
}

export interface LikenessSubmissionRequest {
  tenantId: number;
  character: Pick<Character, "id" | "referenceSource">;
  surface: LikenessSurface;
  provider: string | null | undefined;
  model: string | null | undefined;
  operation: LikenessRecipientOperation;
  /** Exact bytes about to be submitted. */
  sourceSha256: string;
  policyVersion: string;
  /** Uses this submission actually exercises. */
  needs: {
    outfitEdits?: boolean;
    videoDepiction?: boolean;
    scriptedSpeech?: boolean;
  };
  /** Set when the recipient's own identity verification is already satisfied. */
  verifiedIdentitySatisfied?: boolean;
}

export type LikenessSubmissionDecision =
  | {
      status: "allowed";
      /** null for generated cast covered by the standing declaration. */
      grant: CharacterLikenessConsentGrant | null;
      disclosure: CharacterLikenessRecipientDisclosure | null;
    }
  | { status: "not_required" }
  | {
      status: "blocked";
      code:
        | "provider_refused"
        | "attestation_missing"
        | "attestation_stale"
        | "attestation_revoked"
        | "use_not_authorized"
        | "recipient_not_disclosed"
        | "verified_identity_required"
        | "standing_declaration_missing";
      reason: string;
    };

/**
 * The one gate. Every path that can put a human likeness in front of a third
 * party goes through this, whatever the surface, provider or operation.
 *
 * Order matters: provider routing is checked FIRST so a recipient that will
 * certainly refuse the image produces a fast, explained failure instead of a
 * paid rejection, and so the user is never asked to sign an attestation for a
 * submission that could not have succeeded anyway.
 */
export async function evaluateLikenessSubmission(
  input: LikenessSubmissionRequest,
): Promise<LikenessSubmissionDecision> {
  const perCharacter = requiresPerCharacterAttestation(input.character);
  const standing = requiresStandingDeclaration(input.character);
  if (!perCharacter && !standing) return { status: "not_required" };

  const subjectClass = routingSubjectClassFor(input.character);
  const routing = resolveLikenessRouting({
    surface: input.surface,
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    subjectClass,
  });
  if (!routing.allowed) {
    return { status: "blocked", code: "provider_refused", reason: routing.reason };
  }
  if (routing.requiresVerifiedIdentity && !input.verifiedIdentitySatisfied) {
    return {
      status: "blocked",
      code: "verified_identity_required",
      reason:
        `${input.provider} requires its own identity verification for this likeness. ` +
        "The KOKAO attestation records that requirement but never replaces it.",
    };
  }

  if (standing) {
    const declaration = await latestStandingDeclaration(input.tenantId);
    if (!declaration && standingDeclarationEnforced()) {
      return {
        status: "blocked",
        code: "standing_declaration_missing",
        reason:
          "This workspace has not accepted the generated-character declaration. " +
          "Accept it once in workspace settings to continue.",
      };
    }
    return { status: "allowed", grant: null, disclosure: null };
  }

  const grant = await latestGrant(input.tenantId, input.character.id);
  if (!grant) {
    return {
      status: "blocked",
      code: "attestation_missing",
      reason:
        "An uploaded personal likeness needs a likeness-rights attestation before any provider " +
        "can receive it.",
    };
  }
  if (grant.sourceSha256 !== input.sourceSha256) {
    return {
      status: "blocked",
      code: "attestation_stale",
      reason:
        "The attestation is bound to different source bytes than the ones about to be submitted. " +
        "Re-attest for the current source image.",
    };
  }
  if (grant.policyVersion !== input.policyVersion) {
    return {
      status: "blocked",
      code: "attestation_stale",
      reason: "The attestation was made under an earlier policy version and must be renewed.",
    };
  }
  if (await isGrantRevoked(input.tenantId, input.character.id, grant.id)) {
    return {
      status: "blocked",
      // Call sites append their own "no submission was made" context, so this
      // reason stays a single clause.
      code: "attestation_revoked",
      reason: "This likeness attestation was withdrawn.",
    };
  }
  const missingUse = input.needs.outfitEdits && !grant.allowOutfitEdits
    ? "wardrobe and image editing"
    : input.needs.videoDepiction && !grant.allowVideoDepiction
      ? "video depiction"
      : input.needs.scriptedSpeech && !grant.allowScriptedSpeech
        ? "scripted speech"
        : null;
  if (missingUse) {
    return {
      status: "blocked",
      code: "use_not_authorized",
      reason: `This attestation does not authorize ${missingUse}.`,
    };
  }
  const disclosure = await activeRecipientDisclosure({
    tenantId: input.tenantId,
    consentId: grant.id,
    provider: input.provider!,
    model: input.model!,
    operation: input.operation,
  });
  if (!disclosure) {
    return {
      status: "blocked",
      code: "recipient_not_disclosed",
      reason:
        `${input.provider} / ${input.model} has not been disclosed to and acknowledged by the user ` +
        `for ${input.operation}. Acknowledging a new recipient does not require re-attesting.`,
    };
  }
  return { status: "allowed", grant, disclosure };
}

/** Throwing wrapper for call sites that treat a block as an error path. */
export async function assertLikenessSubmissionAllowed(
  input: LikenessSubmissionRequest,
): Promise<LikenessSubmissionDecision> {
  const decision = await evaluateLikenessSubmission(input);
  if (decision.status === "blocked") {
    throw new PersonalLikenessConsentError(decision.reason);
  }
  return decision;
}

/**
 * Freeze an uploaded personal source's exact grant before funding. Generated
 * sources return null here and are governed by the standing declaration.
 */
export async function freezePersonalImageConsent(input: {
  tenantId: number;
  character: Character;
  sourceSha256: string;
  policyVersion: string;
  provider: string;
  model: string;
  operation: Extract<LikenessRecipientOperation, "reference_sheet" | "outfit">;
}): Promise<FrozenPersonalLikenessGrant | null> {
  if (!isPersonalLikenessSource(input.character)) return null;
  const decision = await assertLikenessSubmissionAllowed({
    tenantId: input.tenantId,
    character: input.character,
    surface: "image",
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    sourceSha256: input.sourceSha256,
    policyVersion: input.policyVersion,
    needs: { outfitEdits: true },
  });
  if (decision.status !== "allowed" || !decision.grant) {
    throw new PersonalLikenessConsentError(
      "A current unrevoked personal likeness attestation with image-editing scope is required " +
      "before an image provider can receive this source.",
    );
  }
  return {
    consentId: decision.grant.id,
    sourcePath: decision.grant.sourcePath,
    sourceSha256: decision.grant.sourceSha256,
    policyVersion: decision.grant.policyVersion,
    subjectClass: decision.grant.subjectClass,
  };
}

/**
 * Recheck live ownership, exact bytes, use scope, recipient disclosure and
 * revocation before every provider attempt — including retries and resumed
 * jobs, and including a recipient the pipeline swapped to mid-flight.
 */
export async function assertFrozenPersonalImageConsent(input: {
  tenantId: number;
  characterId: number;
  frozen: FrozenPersonalLikenessGrant | null;
  sourceSha256: string;
  provider: string;
  model: string;
  operation: Extract<LikenessRecipientOperation, "reference_sheet" | "outfit">;
}): Promise<void> {
  if (!input.frozen) return;
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, input.characterId),
    eq(charactersTable.tenantId, input.tenantId),
  )).limit(1);
  if (
    !character ||
    !isPersonalLikenessSource(character) ||
    character.referenceImagePath !== input.frozen.sourcePath ||
    input.frozen.sourceSha256 !== input.sourceSha256
  ) {
    throw new PersonalLikenessConsentError(
      "The frozen personal likeness attestation is no longer current. No image provider submission was made.",
    );
  }
  const decision = await evaluateLikenessSubmission({
    tenantId: input.tenantId,
    character,
    surface: "image",
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    sourceSha256: input.sourceSha256,
    policyVersion: input.frozen.policyVersion,
    needs: { outfitEdits: true },
  });
  if (decision.status !== "allowed" || !decision.grant) {
    throw new PersonalLikenessConsentError(
      decision.status === "blocked"
        ? decision.reason
        : "The frozen personal likeness attestation is no longer current. No image provider submission was made.",
    );
  }
  // A job must stay bound to the grant it was funded against; it must never
  // silently ride a newer attestation that happens to exist today.
  if (decision.grant.id !== input.frozen.consentId) {
    throw new PersonalLikenessConsentError(
      "The personal likeness attestation changed after this job was funded. No image provider submission was made.",
    );
  }
}
