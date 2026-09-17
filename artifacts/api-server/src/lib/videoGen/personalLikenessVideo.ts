import {
  assetProvenanceTable,
  characterLikenessConsentGrantsTable,
  characterLikenessConsentRevocationsTable,
  charactersTable,
  characterOutfitsTable,
  db,
  type Character,
  type CharacterOutfit,
  type GuidedStoryCastSnapshot,
  type GuidedStoryProvenanceEvidence,
  type PersonalLikenessVideoSnapshot,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { isWanPersonalLikenessModel } from "../provenancePolicy";

export class PersonalLikenessVideoError extends Error {}

type Approval = {
  character: { referenceImagePath: string; sha256: string };
  outfit: { referenceImagePath: string; sha256: string };
};

/** Shared narrow routing fence; generated cast continues through its old path. */
export function isFrozenPersonalWanGuidedCast(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  member: GuidedStoryCastSnapshot;
}): boolean {
  return isWanPersonalLikenessModel(input.provider, input.model) &&
    input.member.source === "saved" &&
    input.member.referenceSource === "uploaded" &&
    input.member.personalLikenessVideo?.provider === "atlascloud" &&
    input.member.personalLikenessVideo.model === input.model;
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

async function latestGrant(tenantId: number, characterId: number) {
  return (await db.select().from(characterLikenessConsentGrantsTable).where(and(
    eq(characterLikenessConsentGrantsTable.tenantId, tenantId),
    eq(characterLikenessConsentGrantsTable.characterId, characterId),
  )).orderBy(
    desc(characterLikenessConsentGrantsTable.grantedAt),
    desc(characterLikenessConsentGrantsTable.id),
  ).limit(1))[0] ?? null;
}

async function revoked(tenantId: number, characterId: number, consentId: number): Promise<boolean> {
  return Boolean((await db.select({ id: characterLikenessConsentRevocationsTable.id })
    .from(characterLikenessConsentRevocationsTable)
    .where(and(
      eq(characterLikenessConsentRevocationsTable.tenantId, tenantId),
      eq(characterLikenessConsentRevocationsTable.characterId, characterId),
      eq(characterLikenessConsentRevocationsTable.consentId, consentId),
    )).limit(1))[0]);
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
 * current approved bytes, and append-only grant/evidence records.
 */
export async function freezePersonalWanVideoConsent(input: {
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
  if (!isWanPersonalLikenessModel(input.provider, input.model)) {
    throw new PersonalLikenessVideoError(
      "Uploaded personal likenesses are authorized only for exact Atlas Wan reference-to-video models.",
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
      frozen.provider !== "atlascloud" ||
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
    await assertFrozenPersonalWanVideoConsent({
      tenantId: input.tenantId,
      snapshot: frozen,
      characterSha256: input.characterSha256,
      outfitSha256: input.outfitSha256,
      referenceSheetSha256: input.referenceSheetSha256,
    });
    return frozen;
  }
  const grant = await latestGrant(input.tenantId, input.character.id);
  if (
    !grant ||
    grant.sourceReferenceSource !== "uploaded" ||
    grant.sourcePath !== input.character.referenceImagePath ||
    grant.sourceSha256 !== input.characterSha256 ||
    !grant.providers.includes("atlascloud") ||
    !grant.imageRightsConfirmed ||
    !grant.adultConfirmed ||
    !grant.likenessConfirmed ||
    !grant.writtenPermissionConfirmed ||
    !grant.allowOutfitEdits ||
    (input.scriptedSpeech && !grant.allowScriptedSpeech) ||
    await revoked(input.tenantId, input.character.id, grant.id)
  ) {
    throw new PersonalLikenessVideoError(
      input.scriptedSpeech
        ? "A current unrevoked personal likeness attestation with scripted-speech scope is required before video funding."
        : "A current unrevoked personal likeness attestation for Atlas Wan is required before video funding.",
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
  return {
    version: 1,
    provider: "atlascloud",
    model: input.model as PersonalLikenessVideoSnapshot["model"],
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
}

/** Recheck the frozen grant and live exact source/evidence before every new POST. */
export async function assertFrozenPersonalWanVideoConsent(input: {
  tenantId: number;
  snapshot: PersonalLikenessVideoSnapshot | null | undefined;
  characterSha256: string;
  outfitSha256: string;
  referenceSheetSha256: string;
}): Promise<void> {
  const snapshot = input.snapshot;
  if (!snapshot) return;
  if (!isWanPersonalLikenessModel(snapshot.provider, snapshot.model)) {
    throw new PersonalLikenessVideoError("The frozen personal video provider/model is invalid.");
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
  const grant = await latestGrant(input.tenantId, character.id);
  if (
    !grant ||
    grant.id !== snapshot.consent.consentId ||
    grant.sourcePath !== snapshot.consent.sourcePath ||
    grant.sourceSha256 !== snapshot.consent.sourceSha256 ||
    !grant.providers.includes("atlascloud") ||
    !grant.imageRightsConfirmed ||
    !grant.adultConfirmed ||
    !grant.likenessConfirmed ||
    !grant.writtenPermissionConfirmed ||
    !grant.allowOutfitEdits ||
    (snapshot.scriptedSpeech && !grant.allowScriptedSpeech) ||
    await revoked(input.tenantId, character.id, grant.id)
  ) {
    throw new PersonalLikenessVideoError(
      "The frozen personal likeness attestation is no longer current. No video provider submission was made.",
    );
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