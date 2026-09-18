import {
  assetProvenanceTable,
  charactersTable,
  characterOutfitsTable,
  db,
  type Character,
  type CharacterOutfit,
  type GuidedStoryCastSnapshot,
  type GuidedStoryProvenanceEvidence,
  type PersonalLikenessVideoSnapshot,
  type PersonalLikenessVideoSnapshotV2,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { isLikenessEligibleVideoTarget } from "../provenancePolicy";
import {
  activeRecipientDisclosure,
  evaluateLikenessSubmission,
  latestGrant,
} from "../likenessConsent";
import {
  ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL,
  ATLASCLOUD_WAN_30_REFERENCE_MODEL,
} from "./providers/atlascloud";

export class PersonalLikenessVideoError extends Error {}

type Approval = {
  character: { referenceImagePath: string; sha256: string };
  outfit: { referenceImagePath: string; sha256: string };
};

/** The exact recipients a legacy v1 snapshot was ever allowed to name. */
const V1_MODELS: readonly string[] = [
  ATLASCLOUD_WAN_30_REFERENCE_MODEL,
  ATLASCLOUD_WAN_30_PRIME_REFERENCE_MODEL,
];

function isV1Recipient(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return provider === "atlascloud" && typeof model === "string" && V1_MODELS.includes(model);
}

/**
 * Shared routing fence for a saved uploaded likeness in a guided cast.
 *
 * Generalized from the old Atlas-Wan-only check: eligibility now comes from the
 * reviewed per-provider declarations, so a provider change is a policy edit in
 * one file rather than a new branch here. The frozen snapshot must still name
 * exactly the provider and model about to be dispatched.
 */
export function isFrozenPersonalLikenessGuidedCast(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  member: GuidedStoryCastSnapshot;
}): boolean {
  const frozen = input.member.personalLikenessVideo;
  if (!frozen) return false;
  if (input.member.source !== "saved" || input.member.referenceSource !== "uploaded") {
    return false;
  }
  if (frozen.provider !== input.provider || frozen.model !== input.model) return false;
  return frozen.version === 1
    ? isV1Recipient(input.provider, input.model)
    : isLikenessEligibleVideoTarget(input.provider, input.model, frozen.subjectClass);
}

function validProof(
  proof: GuidedStoryProvenanceEvidence | undefined,
  kind: GuidedStoryProvenanceEvidence["assetKind"],
  path: string,
  sha256: string,
): proof is GuidedStoryProvenanceEvidence {
  return Boolean(
    proof &&
    proof.assetKind === kind &&
    Number.isSafeInteger(proof.provenanceRecordId) &&
    proof.provenanceRecordId > 0 &&
    proof.operationIdentity.trim() &&
    proof.artifactPath === path &&
    proof.artifactSha256 === sha256 &&
    /^[a-f0-9]{64}$/i.test(sha256),
  );
}

function proofFor(
  refs: readonly GuidedStoryProvenanceEvidence[] | undefined,
  kind: GuidedStoryProvenanceEvidence["assetKind"],
  path: string,
  sha256: string,
): GuidedStoryProvenanceEvidence {
  const proof = refs?.find((item) => item.assetKind === kind && item.artifactPath === path);
  if (!validProof(proof, kind, path, sha256)) {
    throw new PersonalLikenessVideoError(
      "The personal likeness video snapshot is missing immutable approved source evidence.",
    );
  }
  return proof;
}

async function assertProofRow(input: {
  tenantId: number;
  characterId: number;
  outfitId?: number;
  proof: GuidedStoryProvenanceEvidence;
  sourceKind: "upload" | "imageedit" | "derived";
  parentPath: string | null;
  parentSha256: string | null;
}): Promise<void> {
  const [row] = await db.select().from(assetProvenanceTable).where(and(
    eq(assetProvenanceTable.id, input.proof.provenanceRecordId),
    eq(assetProvenanceTable.tenantId, input.tenantId),
  )).limit(1);
  if (
    !row ||
    row.tenantId !== input.tenantId ||
    row.characterId !== input.characterId ||
    (input.outfitId !== undefined && row.outfitId !== input.outfitId) ||
    row.assetKind !== input.proof.assetKind ||
    row.operationIdentity !== input.proof.operationIdentity ||
    row.artifactPath !== input.proof.artifactPath ||
    row.artifactSha256 !== input.proof.artifactSha256 ||
    row.sourceKind !== input.sourceKind ||
    input.proof.sourceKind !== input.sourceKind ||
    (row.parentPath ?? null) !== input.parentPath ||
    (row.parentSha256 ?? null) !== input.parentSha256 ||
    (input.proof.parentPath ?? null) !== input.parentPath ||
    (input.proof.parentSha256 ?? null) !== input.parentSha256 ||
    (row.provider ?? null) !== (input.proof.provider ?? null) ||
    (row.model ?? null) !== (input.proof.model ?? null) ||
    JSON.stringify(row.inputAncestry) !== JSON.stringify(input.proof.inputAncestry)
  ) {
    throw new PersonalLikenessVideoError(
      "The personal likeness video source, ancestry, tenant, or provider evidence changed.",
    );
  }
}

/**
 * Create an immutable authorization only from server-selected character rows,
 * current approved bytes, and append-only grant/disclosure/evidence records.
 */
export async function freezePersonalLikenessVideoConsent(input: {
  tenantId: number;
  provider: string;
  model: string;
  character: Character;
  outfit: CharacterOutfit;
  member: GuidedStoryCastSnapshot;
  approval: Approval;
  characterSha256: string;
  outfitSha256: string;
  referenceSheetSha256: string;
  scriptedSpeech: boolean;
  /** Satisfied when the recipient's own identity verification already passed. */
  verifiedIdentitySatisfied?: boolean;
}): Promise<PersonalLikenessVideoSnapshot | null> {
  if (input.character.referenceSource !== "uploaded") return null;
  if (
    input.character.tenantId !== input.tenantId ||
    input.outfit.tenantId !== input.tenantId ||
    input.outfit.characterId !== input.character.id
  ) {
    throw new PersonalLikenessVideoError(
      "The personal likeness character or wardrobe does not belong to this tenant.",
    );
  }
  const sheetPath = input.character.referenceSheetImagePath;
  if (
    !sheetPath ||
    input.character.referenceSheetStatus !== "approved" ||
    input.character.referenceSheetApprovedSha256 !== input.referenceSheetSha256 ||
    input.character.referenceImagePath !== input.approval.character.referenceImagePath ||
    input.characterSha256 !== input.approval.character.sha256 ||
    input.outfit.referenceImagePath !== input.approval.outfit.referenceImagePath ||
    input.outfit.referenceImagePath === input.character.referenceImagePath ||
    input.outfit.status !== "approved" ||
    input.outfit.identityVerified !== true ||
    input.outfit.canonicalReferenceImagePath !== input.character.referenceImagePath
  ) {
    throw new PersonalLikenessVideoError(
      "The selected personal character, approved AI wardrobe, or reference sheet changed.",
    );
  }
  // Recovery/re-render preserves the original authorization. It must never
  // replace it with a newer grant merely because one exists today.
  if (input.member.personalLikenessVideo) {
    const frozen = input.member.personalLikenessVideo;
    if (
      frozen.provider !== input.provider ||
      frozen.model !== input.model ||
      frozen.character.id !== input.character.id ||
      frozen.outfit.id !== input.outfit.id ||
      frozen.character.sha256 !== input.characterSha256 ||
      frozen.outfit.sha256 !== input.outfitSha256 ||
      frozen.referenceSheet.sha256 !== input.referenceSheetSha256 ||
      frozen.scriptedSpeech !== input.scriptedSpeech
    ) {
      throw new PersonalLikenessVideoError(
        "The personal likeness recovery snapshot no longer matches its frozen source, model, or script.",
      );
    }
    await assertFrozenPersonalLikenessVideoConsent({
      tenantId: input.tenantId,
      snapshot: frozen,
      characterSha256: input.characterSha256,
      outfitSha256: input.outfitSha256,
      referenceSheetSha256: input.referenceSheetSha256,
      verifiedIdentitySatisfied: input.verifiedIdentitySatisfied,
    });
    return frozen;
  }
  const decision = await evaluateLikenessSubmission({
    tenantId: input.tenantId,
    character: input.character,
    surface: "video",
    provider: input.provider,
    model: input.model,
    operation: "video",
    sourceSha256: input.characterSha256,
    policyVersion: (await currentPolicyVersion(input.tenantId, input.character.id)) ?? "",
    needs: {
      outfitEdits: true,
      videoDepiction: true,
      scriptedSpeech: input.scriptedSpeech,
    },
    verifiedIdentitySatisfied: input.verifiedIdentitySatisfied,
  });
  if (decision.status !== "allowed" || !decision.grant) {
    throw new PersonalLikenessVideoError(
      decision.status === "blocked"
        ? `${decision.reason} No video funding was reserved.`
        : "A current unrevoked personal likeness attestation is required before video funding.",
    );
  }
  const grant = decision.grant;
  if (grant.sourcePath !== input.character.referenceImagePath) {
    throw new PersonalLikenessVideoError(
      "The personal likeness attestation is bound to a different canonical source path.",
    );
  }
  const refs = input.member.provenanceEvidenceRefs;
  const characterProof = proofFor(
    refs, "character_reference", input.character.referenceImagePath, input.characterSha256,
  );
  const outfitProof = proofFor(
    refs, "character_outfit", input.outfit.referenceImagePath, input.outfitSha256,
  );
  const sheetProof = proofFor(
    refs, "reference_sheet", sheetPath, input.referenceSheetSha256,
  );
  await assertProofRow({
    tenantId: input.tenantId, characterId: input.character.id, proof: characterProof,
    sourceKind: "upload", parentPath: null, parentSha256: null,
  });
  // An approved wardrobe must be an actual AI edit, not the default outfit
  // aliasing the uploaded portrait. Both derived references retain its root.
  await assertProofRow({
    tenantId: input.tenantId,
    characterId: input.character.id,
    outfitId: input.outfit.id,
    proof: outfitProof,
    sourceKind: "imageedit",
    parentPath: input.character.referenceImagePath,
    parentSha256: input.characterSha256,
  });
  await assertProofRow({
    tenantId: input.tenantId,
    characterId: input.character.id,
    proof: sheetProof,
    sourceKind: sheetProof.sourceKind === "derived" ? "derived" : "imageedit",
    parentPath: input.character.referenceImagePath,
    parentSha256: input.characterSha256,
  });
  const snapshot: PersonalLikenessVideoSnapshotV2 = {
    version: 2,
    provider: input.provider,
    model: input.model,
    subjectClass: grant.subjectClass,
    recipientDisclosureId: decision.disclosure?.id ?? null,
    consent: {
      consentId: grant.id,
      sourcePath: grant.sourcePath,
      sourceSha256: grant.sourceSha256,
      policyVersion: grant.policyVersion,
    },
    character: {
      id: input.character.id,
      referenceImagePath: input.character.referenceImagePath,
      sha256: input.characterSha256,
      proof: characterProof,
    },
    outfit: {
      id: input.outfit.id,
      referenceImagePath: input.outfit.referenceImagePath,
      sha256: input.outfitSha256,
      proof: outfitProof,
    },
    referenceSheet: {
      referenceImagePath: sheetPath,
      sha256: input.referenceSheetSha256,
      proof: sheetProof,
    },
    scriptedSpeech: input.scriptedSpeech,
  };
  return snapshot;
}

/**
 * The policy version a freeze must match is the one on the character's own
 * current attestation. Reading it here keeps the caller from having to know
 * how attestation versions are formed.
 */
async function currentPolicyVersion(
  tenantId: number,
  characterId: number,
): Promise<string | null> {
  return (await latestGrant(tenantId, characterId))?.policyVersion ?? null;
}

/** Recheck the frozen grant and live exact source/evidence before every new POST. */
export async function assertFrozenPersonalLikenessVideoConsent(input: {
  tenantId: number;
  snapshot: PersonalLikenessVideoSnapshot | null | undefined;
  characterSha256: string;
  outfitSha256: string;
  referenceSheetSha256: string;
  verifiedIdentitySatisfied?: boolean;
}): Promise<void> {
  const snapshot = input.snapshot;
  if (!snapshot) return;
  const recipientStillAllowed = snapshot.version === 1
    ? isV1Recipient(snapshot.provider, snapshot.model)
    : isLikenessEligibleVideoTarget(
        snapshot.provider,
        snapshot.model,
        snapshot.subjectClass,
      );
  if (!recipientStillAllowed) {
    throw new PersonalLikenessVideoError(
      "The frozen personal video recipient is no longer an eligible target under the current " +
      "provider likeness policy. No video provider submission was made.",
    );
  }
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, snapshot.character.id),
    eq(charactersTable.tenantId, input.tenantId),
  )).limit(1);
  if (
    !character ||
    character.tenantId !== input.tenantId ||
    character.referenceSource !== "uploaded" ||
    character.referenceImagePath !== snapshot.consent.sourcePath ||
    character.referenceImagePath !== snapshot.character.referenceImagePath ||
    snapshot.consent.sourceSha256 !== input.characterSha256 ||
    snapshot.character.sha256 !== input.characterSha256 ||
    character.referenceSheetImagePath !== snapshot.referenceSheet.referenceImagePath ||
    character.referenceSheetApprovedSha256 !== input.referenceSheetSha256 ||
    character.referenceSheetStatus !== "approved"
  ) {
    throw new PersonalLikenessVideoError(
      "The frozen personal likeness source or approved references are no longer current. No video provider submission was made.",
    );
  }
  const decision = await evaluateLikenessSubmission({
    tenantId: input.tenantId,
    character,
    surface: "video",
    provider: snapshot.provider,
    model: snapshot.model,
    operation: "video",
    sourceSha256: input.characterSha256,
    policyVersion: snapshot.consent.policyVersion,
    needs: {
      outfitEdits: true,
      videoDepiction: true,
      scriptedSpeech: snapshot.scriptedSpeech,
    },
    verifiedIdentitySatisfied: input.verifiedIdentitySatisfied,
  });
  if (decision.status !== "allowed" || !decision.grant) {
    throw new PersonalLikenessVideoError(
      decision.status === "blocked"
        ? `${decision.reason} No video provider submission was made.`
        : "The frozen personal likeness attestation is no longer current. No video provider submission was made.",
    );
  }
  if (
    decision.grant.id !== snapshot.consent.consentId ||
    decision.grant.sourcePath !== snapshot.consent.sourcePath ||
    decision.grant.sourceSha256 !== snapshot.consent.sourceSha256
  ) {
    throw new PersonalLikenessVideoError(
      "The frozen personal likeness attestation is no longer current. No video provider submission was made.",
    );
  }
  // A v2 job stays bound to the exact disclosure the user acknowledged, so a
  // later re-acknowledgement of the same provider under a different model can
  // never be substituted for the one this job was funded against.
  if (
    snapshot.version === 2 &&
    snapshot.recipientDisclosureId !== null &&
    decision.disclosure?.id !== snapshot.recipientDisclosureId
  ) {
    throw new PersonalLikenessVideoError(
      "The acknowledged recipient disclosure for this job was withdrawn or replaced. No video provider submission was made.",
    );
  }
  if (snapshot.version === 1) {
    // Legacy rows carry no disclosure id. Require the equivalent live record so
    // a v1 job cannot outlive a withdrawn Atlas recipient.
    const disclosure = await activeRecipientDisclosure({
      tenantId: input.tenantId,
      consentId: snapshot.consent.consentId,
      provider: snapshot.provider,
      model: snapshot.model,
      operation: "video",
    });
    if (!disclosure) {
      throw new PersonalLikenessVideoError(
        "The Atlas recipient for this legacy job is no longer disclosed. No video provider submission was made.",
      );
    }
  }
  const [outfit] = await db.select().from(characterOutfitsTable).where(and(
    eq(characterOutfitsTable.id, snapshot.outfit.id),
    eq(characterOutfitsTable.characterId, character.id),
    eq(characterOutfitsTable.tenantId, input.tenantId),
  )).limit(1);
  if (
    !outfit ||
    outfit.tenantId !== input.tenantId ||
    outfit.referenceImagePath !== snapshot.outfit.referenceImagePath ||
    outfit.referenceImagePath === character.referenceImagePath ||
    outfit.status !== "approved" ||
    outfit.identityVerified !== true ||
    outfit.canonicalReferenceImagePath !== character.referenceImagePath ||
    snapshot.outfit.sha256 !== input.outfitSha256 ||
    snapshot.referenceSheet.sha256 !== input.referenceSheetSha256
  ) {
    throw new PersonalLikenessVideoError(
      "The frozen personal likeness wardrobe or reference sheet is no longer current. No video provider submission was made.",
    );
  }
  await assertProofRow({
    tenantId: input.tenantId, characterId: character.id, proof: snapshot.character.proof,
    sourceKind: "upload", parentPath: null, parentSha256: null,
  });
  await assertProofRow({
    tenantId: input.tenantId, characterId: character.id, outfitId: outfit.id,
    proof: snapshot.outfit.proof, sourceKind: "imageedit",
    parentPath: character.referenceImagePath, parentSha256: input.characterSha256,
  });
  await assertProofRow({
    tenantId: input.tenantId, characterId: character.id,
    proof: snapshot.referenceSheet.proof,
    sourceKind: snapshot.referenceSheet.proof.sourceKind === "derived" ? "derived" : "imageedit",
    parentPath: character.referenceImagePath, parentSha256: input.characterSha256,
  });
}

/** @deprecated Use the provider-independent names. Kept so existing call sites
 * and their tests keep compiling during the rollout. */
export const isFrozenPersonalWanGuidedCast = isFrozenPersonalLikenessGuidedCast;
/** @deprecated */
export const freezePersonalWanVideoConsent = freezePersonalLikenessVideoConsent;
/** @deprecated */
export const assertFrozenPersonalWanVideoConsent = assertFrozenPersonalLikenessVideoConsent;
