import {
  db,
  charactersTable,
  characterOutfitsTable,
  type Character,
  type CharacterOutfit,
} from "@workspace/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { getBytePlusIdentity } from "./bytePlusIdentity";
import {
  createAsset,
  createAssetGroup,
  deleteAsset,
  resolveBytePlusAssetsCredentials,
  waitForAssetActive,
} from "./byteplus/assets";
import {
  createAtlasAsset,
  deleteAtlasAsset,
  getAtlasAsset,
  resolveAtlasAssetsKey,
  waitForAtlasAsset,
  AtlasAssetsError,
} from "./atlascloud/assets";
import {
  isAtlasGenerationReferenceId,
  selectAtlasGenerationReferenceId,
} from "./atlascloud/assetId";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

const storage = new ObjectStorageService();

/** Hash storage bytes, rather than trusting a path, before an Atlas claim. */
export async function atlasSourceSha256(objectPath: string, tenantId: number): Promise<string> {
  const bytes = await storage.getObjectEntityBytes(objectPath, tenantId);
  return createHash("sha256").update(bytes).digest("hex");
}

export function registrationSourceError(character: Pick<Character, "referenceSource" | "bytePlusIdentityId">): string | null {
  if (character.bytePlusIdentityId !== null) {
    return character.referenceSource === "uploaded"
      ? null
      : "A verified real person must use their uploaded reference image.";
  }
  if (character.referenceSource === "generated") return null;
  return character.referenceSource === "uploaded"
    ? "Uploaded photos are never sent to the virtual portrait library without a verified person."
    : "Legacy reference source is unknown; an admin must durably classify it before registration.";
}

export async function registerOutfitAsset(args: {
  tenantId: number;
  character: Character;
  outfit: CharacterOutfit;
}): Promise<CharacterOutfit> {
  if (args.outfit.bytePlusAssetStatus === "Active") return args.outfit;
  const claimDeadline = new Date(Date.now() - 10 * 60_000);
  const [claim] = await db.update(characterOutfitsTable).set({
    bytePlusAssetStatus: "Processing",
    bytePlusAssetClaimedAt: new Date(),
  }).where(and(
    eq(characterOutfitsTable.id, args.outfit.id),
    eq(characterOutfitsTable.tenantId, args.tenantId),
    or(
      isNull(characterOutfitsTable.bytePlusAssetStatus),
      eq(characterOutfitsTable.bytePlusAssetStatus, "Failed"),
      and(eq(characterOutfitsTable.bytePlusAssetStatus, "Processing"),
        lt(characterOutfitsTable.bytePlusAssetClaimedAt, claimDeadline)),
    ),
  )).returning();
  if (!claim) {
    const [current] = await db.select().from(characterOutfitsTable).where(eq(characterOutfitsTable.id, args.outfit.id)).limit(1);
    return current ?? args.outfit;
  }
  const credentials = await resolveBytePlusAssetsCredentials();
  const fail = async (message: string) => {
    const [updated] = await db.update(characterOutfitsTable).set({
      bytePlusAssetStatus: "Failed",
      bytePlusAssetError: message.slice(0, 500),
      bytePlusAssetSyncedAt: new Date(),
      bytePlusAssetClaimedAt: null,
    }).where(and(
      eq(characterOutfitsTable.id, args.outfit.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).returning();
    return updated!;
  };
  if (!credentials) return fail("BytePlus Asset Library is not configured.");

  let groupId: string | null = null;
  const sourceError = registrationSourceError(args.character);
  if (sourceError) return fail(sourceError);
  if (args.character.bytePlusIdentityId !== null) {
    const identity = await getBytePlusIdentity(
      args.tenantId,
      args.character.bytePlusIdentityId,
    );
    if (identity?.status !== "verified" || !identity.assetGroupId) {
      return fail("The linked real person has not completed BytePlus verification.");
    }
    groupId = identity.assetGroupId;
  } else {
    groupId = args.character.bytePlusAssetGroupId;
    if (!groupId) {
      const [groupClaim] = await db.update(charactersTable).set({
        bytePlusAssetGroupClaimedAt: new Date(),
      }).where(and(
        eq(charactersTable.id, args.character.id),
        eq(charactersTable.tenantId, args.tenantId),
        isNull(charactersTable.bytePlusAssetGroupId),
        or(
          isNull(charactersTable.bytePlusAssetGroupClaimedAt),
          lt(charactersTable.bytePlusAssetGroupClaimedAt, claimDeadline),
        ),
      )).returning({ id: charactersTable.id });
      if (!groupClaim) return fail("Another worker is registering this character's BytePlus asset group.");
      try {
        groupId = await createAssetGroup(
          `character-${args.character.id}-${args.character.name}`.slice(0, 100),
          credentials,
        );
      } catch (error) {
        await db.update(charactersTable).set({ bytePlusAssetGroupClaimedAt: null })
          .where(eq(charactersTable.id, args.character.id));
        return fail(error instanceof Error ? error.message : "Asset group creation failed.");
      }
      await db.update(charactersTable).set({ bytePlusAssetGroupId: groupId, bytePlusAssetGroupClaimedAt: null })
        .where(and(
          eq(charactersTable.id, args.character.id),
          eq(charactersTable.tenantId, args.tenantId),
        ));
    }
  }

  try {
    const url = await storage.getSignedDownloadURL(
      args.outfit.referenceImagePath,
      args.tenantId,
      15 * 60,
    );
    const assetId =
      args.outfit.bytePlusAssetStatus === "Processing" && args.outfit.bytePlusAssetId
        ? args.outfit.bytePlusAssetId
        : await createAsset({
            groupId,
            url,
            name: `character-${args.character.id}-outfit-${args.outfit.id}`,
          }, credentials);
    await db.update(characterOutfitsTable).set({
      bytePlusAssetId: assetId,
      bytePlusAssetStatus: "Processing",
      bytePlusAssetError: null,
      bytePlusAssetSyncedAt: new Date(),
      bytePlusAssetClaimedAt: new Date(),
    }).where(eq(characterOutfitsTable.id, args.outfit.id));
    const status = await waitForAssetActive(assetId, credentials);
    const [updated] = await db.update(characterOutfitsTable).set({
      bytePlusAssetStatus: status,
      bytePlusAssetError: status === "Failed" ? "BytePlus rejected this asset." : null,
      bytePlusAssetSyncedAt: new Date(),
      bytePlusAssetClaimedAt: null,
    }).where(eq(characterOutfitsTable.id, args.outfit.id)).returning();
    return updated!;
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Asset registration failed.");
  }
}

export function registerOutfitAssetInBackground(args: {
  tenantId: number;
  character: Character;
  outfit: CharacterOutfit;
}): void {
  void registerOutfitAsset(args).catch((error) =>
    logger.warn(
      { err: error, characterId: args.character.id, outfitId: args.outfit.id },
      "BytePlus asset registration failed",
    ));
}

export async function registerCharacterAssets(args: {
  tenantId: number;
  characterId: number;
}): Promise<void> {
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, args.characterId),
    eq(charactersTable.tenantId, args.tenantId),
  )).limit(1);
  if (!character) return;
  const outfits = await db.select().from(characterOutfitsTable).where(and(
    eq(characterOutfitsTable.characterId, character.id),
    eq(characterOutfitsTable.tenantId, args.tenantId),
  ));
  for (const outfit of outfits) {
    if (outfit.bytePlusAssetStatus !== "Active") {
      await registerOutfitAsset({ tenantId: args.tenantId, character, outfit });
    }
  }
}

export async function assetRefsForOutfit(args: {
  tenantId: number;
  character: Character;
  outfit: CharacterOutfit;
}): Promise<string[]> {
  // Snapshot-backed retries intentionally carry only identity image data. Read
  // the current registration metadata by tenant/id; if the row was deleted,
  // the caller safely falls back to its durable keyframe path.
  const [registeredOutfit] = await db.select().from(characterOutfitsTable).where(and(
    eq(characterOutfitsTable.id, args.outfit.id),
    eq(characterOutfitsTable.characterId, args.character.id),
    eq(characterOutfitsTable.tenantId, args.tenantId),
  )).limit(1);
  if (
    !registeredOutfit ||
    registeredOutfit.bytePlusAssetStatus !== "Active" ||
    !registeredOutfit.bytePlusAssetId
  ) return [];
  const refs = [registeredOutfit.bytePlusAssetId];
  const [base] = await db.select().from(characterOutfitsTable).where(and(
    eq(characterOutfitsTable.characterId, args.character.id),
    eq(characterOutfitsTable.tenantId, args.tenantId),
    eq(characterOutfitsTable.isDefault, true),
  )).limit(1);
  if (
    base && base.id !== args.outfit.id && base.bytePlusAssetStatus === "Active" &&
    base.bytePlusAssetId && base.referenceImagePath !== args.outfit.referenceImagePath
  ) refs.push(base.bytePlusAssetId);
  return refs;
}

/** A real-person identity may never degrade to an inline portrait fallback. */
export async function requiresVerifiedBytePlusAsset(
  tenantId: number,
  characterId: number,
): Promise<boolean> {
  const [character] = await db.select({ identityId: charactersTable.bytePlusIdentityId })
    .from(charactersTable).where(and(
      eq(charactersTable.id, characterId),
      eq(charactersTable.tenantId, tenantId),
    )).limit(1);
  return character?.identityId != null;
}

export async function currentBytePlusAssetPolicy(
  tenantId: number,
  characterId: number,
): Promise<{ exists: boolean; requiresBytePlusAsset: boolean; requiresAtlasAsset: boolean }> {
  const [character] = await db.select({
    identityId: charactersTable.bytePlusIdentityId,
    referenceSource: charactersTable.referenceSource,
  })
    .from(charactersTable).where(and(
      eq(charactersTable.id, characterId),
      eq(charactersTable.tenantId, tenantId),
    )).limit(1);
  return {
    exists: Boolean(character),
    requiresBytePlusAsset: character?.identityId != null,
    requiresAtlasAsset: character?.referenceSource === "generated",
  };
}

export function deleteBytePlusAssetsInBackground(ids: Array<string | null>): void {
  const assetIds = ids.filter((id): id is string => Boolean(id));
  if (!assetIds.length) return;
  void (async () => {
    const credentials = await resolveBytePlusAssetsCredentials();
    if (!credentials) return;
    for (const id of assetIds) {
      await deleteAsset(id, credentials).catch((error) =>
        logger.warn({ err: error, assetId: id }, "BytePlus asset cleanup failed"));
    }
  })();
}

export function atlasRegistrationSourceError(
  character: Pick<Character, "referenceSource" | "bytePlusIdentityId">,
  outfit: Pick<CharacterOutfit, "status" | "identityVerified">,
): string | null {
  if (character.bytePlusIdentityId !== null) {
    return "BytePlus-verified real-person identities can never be registered with Atlas Cloud.";
  }
  if (character.referenceSource === "uploaded") {
    return "Uploaded reference images can never be registered with Atlas Cloud.";
  }
  if (character.referenceSource !== "generated") {
    return "Only explicitly classified AI-generated fictional characters can use Atlas Cloud assets.";
  }
  if (outfit.status !== "approved" || !outfit.identityVerified) {
    return "Only approved, identity-verified generated outfits can use Atlas Cloud assets.";
  }
  return null;
}

/** Register the approved multi-view identity sheet before any outfit asset. */
export async function registerAtlasCharacterAsset(args: {
  tenantId: number;
  character: Character;
  expectedReferenceSheetPath?: string;
  expectedSourceSha256?: string;
  /** Test seam for a committed write whose acknowledgement path throws. */
  afterMappingPersistence?: () => void;
}): Promise<Character> {
  let leaseOwner: string | null = null;
  const fail = async (message: string): Promise<Character> => {
    if (!leaseOwner) {
      return { ...args.character, atlasAssetStatus: "Failed", atlasAssetError: message.slice(0, 500) };
    }
    const [updated] = await db.update(charactersTable).set({
      atlasAssetStatus: "Failed",
      atlasAssetError: message.slice(0, 500),
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: null,
      atlasAssetLeaseOwner: null,
    }).where(and(
      eq(charactersTable.id, args.character.id),
      eq(charactersTable.tenantId, args.tenantId),
      eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
      eq(charactersTable.referenceSheetImagePath, args.expectedReferenceSheetPath!),
      eq(charactersTable.referenceSheetApprovedSha256, args.expectedSourceSha256!),
      eq(charactersTable.referenceSheetStatus, "approved"),
    )).returning();
    return updated ?? args.character;
  };
  if (!args.expectedReferenceSheetPath || !args.expectedSourceSha256) {
    return fail("Atlas registration requires an exact approved reference sheet path and SHA-256 digest.");
  }
  if (args.character.bytePlusIdentityId !== null) {
    return fail("BytePlus-verified real-person identities can never be registered with Atlas Cloud.");
  }
  if (args.character.referenceSource === "uploaded") {
    return fail("Uploaded reference images can never be registered with Atlas Cloud.");
  }
  if (args.character.referenceSource !== "generated") {
    return fail("Only explicitly classified AI-generated fictional characters can use Atlas Cloud assets.");
  }
  if (
    args.character.referenceSheetStatus !== "approved" ||
    !args.character.referenceSheetImagePath
  ) {
    return fail("Approve this fictional character's exact reference sheet before Atlas registration.");
  }
  if (
    args.expectedReferenceSheetPath !== undefined &&
    args.character.referenceSheetImagePath !== args.expectedReferenceSheetPath
  ) {
    return fail("The approved character reference sheet changed before Atlas registration. Review and approve it again.");
  }
  const historicalRecordId =
    args.character.atlasAssetId && /^\d+$/.test(args.character.atlasAssetId)
      ? Number(args.character.atlasAssetId)
      : null;
  const libraryRecordId = args.character.atlasAssetLibraryId ?? historicalRecordId;
  const generationReferenceId = selectAtlasGenerationReferenceId(
    args.character.atlasAssetReferenceId,
    args.character.atlasAssetId,
  );
  if (
    (args.character.atlasAssetReferenceId !== null &&
      !isAtlasGenerationReferenceId(args.character.atlasAssetReferenceId)) ||
    (args.character.atlasAssetId !== null &&
      !/^\d+$/.test(args.character.atlasAssetId) &&
      !isAtlasGenerationReferenceId(args.character.atlasAssetId))
  ) {
    return fail("Stored Atlas character ids use an invalid namespace. An admin must reconcile them; registration was not repeated.");
  }
  if (
    libraryRecordId &&
    (
      (args.expectedReferenceSheetPath !== undefined &&
        args.character.atlasAssetSourcePath !== args.expectedReferenceSheetPath) ||
      (args.expectedSourceSha256 !== undefined &&
        args.character.atlasAssetSourceSha256 !== args.expectedSourceSha256)
    )
  ) {
    return fail("The stored Atlas character mapping has no exact match to the approved sheet bytes. Reconcile it in Atlas before retrying; registration was not repeated.");
  }
  if (
    args.character.atlasAssetStatus === "Active" &&
    libraryRecordId &&
    generationReferenceId
  ) {
    if (
      (args.expectedReferenceSheetPath !== undefined &&
        args.character.atlasAssetSourcePath !== args.expectedReferenceSheetPath) ||
      (args.expectedSourceSha256 !== undefined &&
        args.character.atlasAssetSourceSha256 !== args.expectedSourceSha256)
    ) {
      return fail("The ready Atlas character asset belongs to different approved sheet bytes. Remove/reconcile that Atlas asset before registering the replacement.");
    }
    const reused = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(charactersTable).where(and(
        eq(charactersTable.id, args.character.id),
        eq(charactersTable.tenantId, args.tenantId),
      )).for("update").limit(1);
      const lockedReferenceId = locked && selectAtlasGenerationReferenceId(
        locked.atlasAssetReferenceId,
        locked.atlasAssetId,
      );
      return locked &&
        locked.referenceSource === "generated" &&
        locked.bytePlusIdentityId === null &&
        locked.referenceSheetStatus === "approved" &&
        locked.referenceSheetImagePath === args.expectedReferenceSheetPath &&
        locked.referenceSheetApprovedSha256 === args.expectedSourceSha256 &&
        locked.atlasAssetSourcePath === args.expectedReferenceSheetPath &&
        locked.atlasAssetSourceSha256 === args.expectedSourceSha256 &&
        locked.atlasAssetStatus === "Active" &&
        locked.atlasAssetLibraryId === libraryRecordId &&
        lockedReferenceId === generationReferenceId
        ? locked
        : null;
    });
    if (reused) return reused;
    return fail("The approved character or its frozen Atlas mapping changed before reuse.");
  }
  if (
    !libraryRecordId &&
    (args.character.atlasAssetId || args.character.atlasAssetReferenceId)
  ) {
    return fail("Atlas character mapping has no numeric Asset Library record id. Reconcile it in Atlas before retrying; registration was not repeated.");
  }

  const stale = new Date(Date.now() - 10 * 60_000);
  leaseOwner = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, args.character.id),
      eq(charactersTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    if (!locked) return undefined;
    const lockedLibraryRecordId = locked.atlasAssetLibraryId ??
      (locked.atlasAssetId && /^\d+$/.test(locked.atlasAssetId)
        ? Number(locked.atlasAssetId)
        : null);
    const needsGetOnlyReconciliation = Boolean(
      lockedLibraryRecordId &&
      !selectAtlasGenerationReferenceId(locked.atlasAssetReferenceId, locked.atlasAssetId),
    );
    if (
      (locked.atlasAssetFenceState === "submitting" ||
        locked.atlasAssetFenceState === "outcome_unknown") &&
      !lockedLibraryRecordId
    ) return undefined;
    const leaseAvailable =
      locked.atlasAssetStatus === null ||
      locked.atlasAssetStatus === "Failed" ||
      needsGetOnlyReconciliation ||
      (locked.atlasAssetStatus === "Processing" &&
        (!locked.atlasAssetClaimedAt || locked.atlasAssetClaimedAt < stale));
    if (
      !leaseAvailable ||
      locked.referenceSource !== "generated" ||
      locked.bytePlusIdentityId !== null ||
      locked.referenceSheetStatus !== "approved" ||
      locked.referenceSheetImagePath !== args.expectedReferenceSheetPath ||
      locked.referenceSheetApprovedSha256 !== args.expectedSourceSha256
    ) return undefined;
    const [row] = await tx.update(charactersTable).set({
      atlasAssetStatus: "Processing",
      atlasAssetClaimedAt: new Date(),
      atlasAssetLeaseOwner: leaseOwner,
    }).where(and(
      eq(charactersTable.id, locked.id),
      eq(charactersTable.tenantId, args.tenantId),
    )).returning();
    return row;
  });
  if (!claimed) {
    const [current] = await db.select().from(charactersTable).where(and(
      eq(charactersTable.id, args.character.id),
      eq(charactersTable.tenantId, args.tenantId),
    )).limit(1);
    return current ?? args.character;
  }
  const apiKey = await resolveAtlasAssetsKey();
  if (!apiKey) return fail("Atlas Cloud is not configured.");
  let crossedProviderBoundary = false;
  let knownCreatedRecordId: number | null = null;
  try {
    let existingRecordId = claimed.atlasAssetLibraryId ??
      (claimed.atlasAssetId && /^\d+$/.test(claimed.atlasAssetId)
        ? Number(claimed.atlasAssetId)
        : null);
    if (!existingRecordId && claimed.atlasAssetSubmitFencedAt) {
      return fail("Atlas character submission was started but its ids were not durably saved. Reconcile the Atlas console before retrying; registration was not repeated.");
    }
    if (
      existingRecordId &&
      claimed.atlasAssetFenceState === "compensated" &&
      !selectAtlasGenerationReferenceId(claimed.atlasAssetReferenceId, claimed.atlasAssetId)
    ) {
      try {
        await getAtlasAsset(existingRecordId, apiKey);
      } catch (error) {
        if (error instanceof AtlasAssetsError && error.status === 404) {
          const cleared = await db.transaction(async (tx) => {
            await tx.select({ id: charactersTable.id }).from(charactersTable).where(and(
              eq(charactersTable.id, claimed.id),
              eq(charactersTable.tenantId, args.tenantId),
            )).for("update").limit(1);
            const [row] = await tx.update(charactersTable).set({
              atlasAssetLibraryId: null,
              atlasAssetSubmitFencedAt: null,
              atlasAssetFenceState: null,
              atlasAssetCompensationError: null,
            }).where(and(
              eq(charactersTable.id, claimed.id),
              eq(charactersTable.tenantId, args.tenantId),
              eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
              eq(charactersTable.atlasAssetLibraryId, existingRecordId!),
              eq(charactersTable.atlasAssetFenceState, "compensated"),
              eq(charactersTable.referenceSheetStatus, "approved"),
              eq(charactersTable.referenceSheetImagePath, args.expectedReferenceSheetPath!),
              eq(charactersTable.referenceSheetApprovedSha256, args.expectedSourceSha256!),
              eq(charactersTable.atlasAssetSourcePath, args.expectedReferenceSheetPath!),
              eq(charactersTable.atlasAssetSourceSha256, args.expectedSourceSha256!),
            )).returning();
            return row;
          });
          if (!cleared) return claimed;
          existingRecordId = null;
        } else {
          const message = error instanceof Error ? error.message : "Compensated Atlas asset absence could not be verified.";
          const [unknown] = await db.update(charactersTable).set({
            atlasAssetStatus: "Failed",
            atlasAssetClaimedAt: null,
            atlasAssetLeaseOwner: null,
            atlasAssetFenceState: "compensated",
            atlasAssetCompensationError: message.slice(0, 500),
            atlasAssetError: message.slice(0, 500),
            atlasAssetSyncedAt: new Date(),
          }).where(and(
            eq(charactersTable.id, claimed.id),
            eq(charactersTable.tenantId, args.tenantId),
            eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
            eq(charactersTable.atlasAssetLibraryId, existingRecordId),
            eq(charactersTable.atlasAssetFenceState, "compensated"),
          )).returning();
          return unknown ?? claimed;
        }
      }
    }
    let created: Awaited<ReturnType<typeof createAtlasAsset>> | null = null;
    if (!existingRecordId) {
      const url = await storage.getSignedDownloadURL(
        claimed.referenceSheetImagePath!,
        args.tenantId,
        15 * 60,
      );
      const fenced = await db.transaction(async (tx) => {
        await tx.select({ id: charactersTable.id }).from(charactersTable).where(and(
          eq(charactersTable.id, claimed.id),
          eq(charactersTable.tenantId, args.tenantId),
        )).for("update").limit(1);
        const [row] = await tx.update(charactersTable).set({
          atlasAssetSubmitFencedAt: new Date(),
          atlasAssetFenceState: "submitting",
        }).where(and(
          eq(charactersTable.id, claimed.id),
          eq(charactersTable.tenantId, args.tenantId),
          eq(charactersTable.atlasAssetClaimedAt, claimed.atlasAssetClaimedAt!),
          eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
          eq(charactersTable.referenceSheetImagePath, claimed.referenceSheetImagePath!),
          eq(charactersTable.referenceSheetApprovedSha256, args.expectedSourceSha256!),
          eq(charactersTable.referenceSheetStatus, "approved"),
          isNull(charactersTable.atlasAssetLibraryId),
          isNull(charactersTable.atlasAssetSubmitFencedAt),
        )).returning();
        return row;
      });
      if (!fenced) {
        const [current] = await db.select().from(charactersTable).where(and(
          eq(charactersTable.id, claimed.id),
          eq(charactersTable.tenantId, args.tenantId),
        )).limit(1);
        return current ?? claimed;
      }
      crossedProviderBoundary = true;
      created = await createAtlasAsset(url, apiKey);
      if (Number.isInteger(created.libraryRecordId) && created.libraryRecordId > 0) {
        knownCreatedRecordId = created.libraryRecordId;
      }
    }
    const recordId = existingRecordId ?? created!.libraryRecordId;
    const [persisted] = await db.update(charactersTable).set({
      atlasAssetLibraryId: recordId,
      atlasAssetReferenceId: created?.generationReferenceId ?? generationReferenceId,
      atlasAssetId: created?.generationReferenceId ?? generationReferenceId,
      atlasAssetStatus: "Processing",
      atlasAssetError: null,
      atlasAssetSyncedAt: new Date(),
      atlasAssetSourcePath: claimed.referenceSheetImagePath,
      atlasAssetSourceSha256: args.expectedSourceSha256 ?? null,
    }).where(and(
      eq(charactersTable.id, claimed.id),
      eq(charactersTable.tenantId, args.tenantId),
      eq(charactersTable.referenceSheetImagePath, claimed.referenceSheetImagePath!),
      eq(charactersTable.atlasAssetClaimedAt, claimed.atlasAssetClaimedAt!),
      eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
      eq(charactersTable.referenceSheetApprovedSha256, args.expectedSourceSha256),
      eq(charactersTable.referenceSheetStatus, "approved"),
    )).returning({ id: charactersTable.id });
    args.afterMappingPersistence?.();
    if (!persisted) {
      if (created) {
        try {
          await deleteAtlasAsset(recordId, apiKey);
          const [compensated] = await db.update(charactersTable).set({
            atlasAssetLibraryId: recordId,
            atlasAssetReferenceId: null,
            atlasAssetId: null,
            atlasAssetStatus: "Failed",
            atlasAssetError: "Atlas creation was compensated after local persistence lost its lease.",
            atlasAssetSyncedAt: new Date(),
            atlasAssetClaimedAt: null,
            atlasAssetLeaseOwner: null,
            atlasAssetFenceState: "compensated",
            atlasAssetCompensationError: null,
            atlasAssetSourcePath: claimed.referenceSheetImagePath,
            atlasAssetSourceSha256: args.expectedSourceSha256,
          }).where(and(
            eq(charactersTable.id, claimed.id),
            eq(charactersTable.tenantId, args.tenantId),
            eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
          )).returning();
          crossedProviderBoundary = false;
          return compensated ?? claimed;
        } catch (compensationError) {
          const [unknown] = await db.update(charactersTable).set({
            atlasAssetLibraryId: recordId,
            atlasAssetFenceState: "outcome_unknown",
            atlasAssetCompensationError: compensationError instanceof Error
              ? compensationError.message.slice(0, 500)
              : "Atlas compensation failed.",
          }).where(and(
            eq(charactersTable.id, claimed.id),
            eq(charactersTable.tenantId, args.tenantId),
            eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
          )).returning();
          return unknown ?? claimed;
        }
      }
      throw new Error("Atlas character creation succeeded but local persistence lost its fenced lease.");
    }
    knownCreatedRecordId = null;
    const result = await waitForAtlasAsset(recordId, apiKey);
    const [updated] = await db.update(charactersTable).set({
      atlasAssetLibraryId: result.libraryRecordId,
      atlasAssetReferenceId: result.generationReferenceId,
      atlasAssetId: result.generationReferenceId,
      atlasAssetStatus: result.status,
      atlasAssetError: result.error,
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: null,
      atlasAssetLeaseOwner: null,
      atlasAssetFenceState: "resolved",
      atlasAssetSourcePath: claimed.referenceSheetImagePath,
      atlasAssetSourceSha256: args.expectedSourceSha256 ?? null,
    }).where(and(
      eq(charactersTable.id, claimed.id),
      eq(charactersTable.tenantId, args.tenantId),
      eq(charactersTable.referenceSheetImagePath, claimed.referenceSheetImagePath!),
      eq(charactersTable.referenceSheetStatus, "approved"),
      eq(charactersTable.referenceSheetApprovedSha256, args.expectedSourceSha256),
      eq(charactersTable.atlasAssetClaimedAt, claimed.atlasAssetClaimedAt!),
      eq(charactersTable.atlasAssetLeaseOwner, leaseOwner),
    )).returning();
    return updated ?? fail("The character reference sheet changed during Atlas registration.");
  } catch (error) {
    if (crossedProviderBoundary && knownCreatedRecordId !== null) {
      try {
        await deleteAtlasAsset(knownCreatedRecordId, apiKey);
        const [compensated] = await db.update(charactersTable).set({
          atlasAssetLibraryId: knownCreatedRecordId,
          atlasAssetReferenceId: null,
          atlasAssetId: null,
          atlasAssetStatus: "Failed",
          atlasAssetError: "Atlas creation was compensated after local persistence failed.",
          atlasAssetSyncedAt: new Date(),
          atlasAssetClaimedAt: null,
          atlasAssetLeaseOwner: null,
          atlasAssetFenceState: "compensated",
          atlasAssetCompensationError: null,
          atlasAssetSourcePath: args.expectedReferenceSheetPath,
          atlasAssetSourceSha256: args.expectedSourceSha256,
        }).where(and(
          eq(charactersTable.id, args.character.id),
          eq(charactersTable.tenantId, args.tenantId),
          eq(charactersTable.atlasAssetLeaseOwner, leaseOwner!),
        )).returning();
        crossedProviderBoundary = false;
        return compensated ?? args.character;
      } catch (compensationError) {
        const message = compensationError instanceof Error
          ? compensationError.message
          : "Atlas compensation failed.";
        const [unknown] = await db.update(charactersTable).set({
          atlasAssetLibraryId: knownCreatedRecordId,
          atlasAssetFenceState: "outcome_unknown",
          atlasAssetCompensationError: message.slice(0, 500),
          atlasAssetError: (error instanceof Error ? error.message : "Local Atlas persistence failed.").slice(0, 500),
          atlasAssetSyncedAt: new Date(),
        }).where(and(
          eq(charactersTable.id, args.character.id),
          eq(charactersTable.tenantId, args.tenantId),
          eq(charactersTable.atlasAssetLeaseOwner, leaseOwner!),
        )).returning();
        return unknown ?? args.character;
      }
    }
    if (
      crossedProviderBoundary &&
      (!(error instanceof AtlasAssetsError) ||
        error.status === undefined ||
        error.status >= 500)
    ) {
      const message = error instanceof Error ? error.message : "Atlas submission outcome is unknown.";
      const [unknown] = await db.update(charactersTable).set({
        atlasAssetFenceState: "outcome_unknown",
        atlasAssetError: message.slice(0, 500),
        atlasAssetSyncedAt: new Date(),
      }).where(and(
        eq(charactersTable.id, args.character.id),
        eq(charactersTable.tenantId, args.tenantId),
        eq(charactersTable.atlasAssetLeaseOwner, leaseOwner!),
        eq(charactersTable.referenceSheetImagePath, args.expectedReferenceSheetPath),
        eq(charactersTable.referenceSheetApprovedSha256, args.expectedSourceSha256),
        eq(charactersTable.referenceSheetStatus, "approved"),
      )).returning();
      return unknown ?? args.character;
    }
    return fail(error instanceof Error ? error.message : "Atlas Cloud character registration failed.");
  }
}

/** Register one tenant-owned, approved fictional outfit under a ten-minute lease. */
export async function registerAtlasOutfitAsset(args: {
  tenantId: number;
  character: Character;
  outfit: CharacterOutfit;
  expectedSourcePath?: string;
  expectedSourceSha256?: string;
  /** Test seam for a committed write whose acknowledgement path throws. */
  afterMappingPersistence?: () => void;
}): Promise<CharacterOutfit> {
  const policyError = atlasRegistrationSourceError(args.character, args.outfit);
  let leaseOwner: string | null = null;
  const failWithoutClaim = async (message: string): Promise<CharacterOutfit> => {
    if (!leaseOwner) {
      return { ...args.outfit, atlasAssetStatus: "Failed", atlasAssetError: message.slice(0, 500) };
    }
    const [updated] = await db.update(characterOutfitsTable).set({
      atlasAssetStatus: "Failed",
      atlasAssetError: message.slice(0, 500),
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: null,
      atlasAssetLeaseOwner: null,
    }).where(and(
      eq(characterOutfitsTable.id, args.outfit.id),
      eq(characterOutfitsTable.characterId, args.character.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
      eq(characterOutfitsTable.referenceImagePath, args.outfit.referenceImagePath),
      eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
      eq(characterOutfitsTable.atlasApprovedSourceSha256, args.expectedSourceSha256!),
      eq(characterOutfitsTable.status, "approved"),
      eq(characterOutfitsTable.identityVerified, true),
    )).returning();
    return updated ?? args.outfit;
  };
  if (policyError) return failWithoutClaim(policyError);
  if (!args.expectedSourcePath || !args.expectedSourceSha256) {
    return failWithoutClaim("Atlas registration requires an exact approved outfit path and SHA-256 digest.");
  }
  const historicalRecordId =
    args.outfit.atlasAssetId && /^\d+$/.test(args.outfit.atlasAssetId)
      ? Number(args.outfit.atlasAssetId)
      : null;
  const libraryRecordId = args.outfit.atlasAssetLibraryId ?? historicalRecordId;
  const malformedCanonicalReference =
    args.outfit.atlasAssetReferenceId !== null &&
    !isAtlasGenerationReferenceId(args.outfit.atlasAssetReferenceId);
  const generationReferenceId = selectAtlasGenerationReferenceId(
    args.outfit.atlasAssetReferenceId,
    args.outfit.atlasAssetId,
  );
  if (
    libraryRecordId &&
    (
      (args.expectedSourcePath !== undefined &&
        args.outfit.atlasAssetSourcePath !== args.expectedSourcePath) ||
      (args.expectedSourceSha256 !== undefined &&
        args.outfit.atlasAssetSourceSha256 !== args.expectedSourceSha256)
    )
  ) {
    return failWithoutClaim(
      "The stored Atlas outfit mapping has no exact match to the approved bytes. Reconcile it in Atlas before retrying; registration was not repeated.",
    );
  }
  if (malformedCanonicalReference) {
    return failWithoutClaim(
      "Stored Atlas generation reference is malformed and has no numeric Asset Library record id. An admin must reconcile it; registration was not repeated.",
    );
  }
  if (
    args.outfit.atlasAssetStatus === "Active" &&
    libraryRecordId &&
    generationReferenceId &&
    !malformedCanonicalReference
  ) {
    if (
      (args.expectedSourcePath !== undefined &&
        args.outfit.atlasAssetSourcePath !== args.expectedSourcePath) ||
      (args.expectedSourceSha256 !== undefined &&
        args.outfit.atlasAssetSourceSha256 !== args.expectedSourceSha256)
    ) {
      return failWithoutClaim(
        "The ready Atlas outfit asset belongs to different approved bytes. Remove/reconcile that Atlas asset before registering the replacement.",
      );
    }
    const reused = await db.transaction(async (tx) => {
      const [parent] = await tx.select().from(charactersTable).where(and(
        eq(charactersTable.id, args.character.id),
        eq(charactersTable.tenantId, args.tenantId),
      )).for("update").limit(1);
      if (!parent) return null;
      const parentReferenceId = selectAtlasGenerationReferenceId(
        parent.atlasAssetReferenceId,
        parent.atlasAssetId,
      );
      const expectedParentReferenceId = selectAtlasGenerationReferenceId(
        args.character.atlasAssetReferenceId,
        args.character.atlasAssetId,
      );
      if (
        parent.referenceSource !== "generated" ||
        parent.bytePlusIdentityId !== null ||
        parent.referenceSheetStatus !== "approved" ||
        parent.referenceSheetImagePath !== args.character.referenceSheetImagePath ||
        parent.referenceSheetApprovedSha256 !== args.character.referenceSheetApprovedSha256 ||
        parent.atlasAssetSourcePath !== parent.referenceSheetImagePath ||
        parent.atlasAssetSourceSha256 !== parent.referenceSheetApprovedSha256 ||
        parent.atlasAssetStatus !== "Active" ||
        parent.atlasAssetLibraryId !== args.character.atlasAssetLibraryId ||
        parentReferenceId !== expectedParentReferenceId
      ) return null;
      const [locked] = await tx.select().from(characterOutfitsTable).where(and(
        eq(characterOutfitsTable.id, args.outfit.id),
        eq(characterOutfitsTable.characterId, parent.id),
        eq(characterOutfitsTable.tenantId, args.tenantId),
      )).for("update").limit(1);
      const lockedReferenceId = locked && selectAtlasGenerationReferenceId(
        locked.atlasAssetReferenceId,
        locked.atlasAssetId,
      );
      return locked &&
        locked.status === "approved" &&
        locked.identityVerified &&
        locked.referenceImagePath === args.expectedSourcePath &&
        locked.atlasApprovedSourceSha256 === args.expectedSourceSha256 &&
        locked.atlasAssetSourcePath === args.expectedSourcePath &&
        locked.atlasAssetSourceSha256 === args.expectedSourceSha256 &&
        locked.atlasAssetStatus === "Active" &&
        locked.atlasAssetLibraryId === libraryRecordId &&
        lockedReferenceId === generationReferenceId
        ? locked
        : null;
    });
    if (reused) return reused;
    return failWithoutClaim("The approved parent, outfit, or frozen Atlas mapping changed before reuse.");
  }
  if (
    !libraryRecordId &&
    (args.outfit.atlasAssetId || args.outfit.atlasAssetReferenceId)
  ) {
    return failWithoutClaim(
      "Legacy Atlas mapping has no numeric Asset Library record id. An admin must reconcile it in Atlas before retrying; registration was not repeated.",
    );
  }
  const stale = new Date(Date.now() - 10 * 60_000);
  leaseOwner = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const [parent] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, args.character.id),
      eq(charactersTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    if (
      !parent ||
      parent.referenceSource !== "generated" ||
      parent.bytePlusIdentityId !== null ||
      parent.referenceSheetStatus !== "approved" ||
      !parent.referenceSheetImagePath ||
      !parent.referenceSheetApprovedSha256 ||
      parent.atlasAssetSourcePath !== parent.referenceSheetImagePath ||
      parent.atlasAssetSourceSha256 !== parent.referenceSheetApprovedSha256 ||
      parent.atlasAssetStatus !== "Active" ||
      !parent.atlasAssetLibraryId ||
      !selectAtlasGenerationReferenceId(parent.atlasAssetReferenceId, parent.atlasAssetId)
    ) return undefined;
    const [locked] = await tx.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.id, args.outfit.id),
      eq(characterOutfitsTable.characterId, parent.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    if (!locked) return undefined;
    const lockedLibraryRecordId = locked.atlasAssetLibraryId ??
      (locked.atlasAssetId && /^\d+$/.test(locked.atlasAssetId)
        ? Number(locked.atlasAssetId)
        : null);
    const needsGetOnlyReconciliation = Boolean(
      lockedLibraryRecordId &&
      !selectAtlasGenerationReferenceId(locked.atlasAssetReferenceId, locked.atlasAssetId),
    );
    if (
      (locked.atlasAssetFenceState === "submitting" ||
        locked.atlasAssetFenceState === "outcome_unknown") &&
      !lockedLibraryRecordId
    ) return undefined;
    const leaseAvailable =
      locked.atlasAssetStatus === null ||
      locked.atlasAssetStatus === "Failed" ||
      needsGetOnlyReconciliation ||
      (locked.atlasAssetStatus === "Processing" &&
        (!locked.atlasAssetClaimedAt || locked.atlasAssetClaimedAt < stale));
    if (
      !leaseAvailable ||
      locked.referenceImagePath !== args.expectedSourcePath ||
      locked.status !== "approved" ||
      !locked.identityVerified ||
      locked.atlasApprovedSourceSha256 !== args.expectedSourceSha256
    ) return undefined;
    const [row] = await tx.update(characterOutfitsTable).set({
      atlasAssetStatus: "Processing",
      atlasAssetClaimedAt: new Date(),
      atlasAssetLeaseOwner: leaseOwner,
    }).where(and(
      eq(characterOutfitsTable.id, locked.id),
      eq(characterOutfitsTable.characterId, parent.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).returning();
    return row;
  });
  if (!claimed) {
    const [current] = await db.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.id, args.outfit.id),
      eq(characterOutfitsTable.characterId, args.character.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).limit(1);
    return current ?? args.outfit;
  }
  const fail = (message: string) => failWithoutClaim(message);
  const apiKey = await resolveAtlasAssetsKey();
  if (!apiKey) return fail("Atlas Cloud is not configured.");

  let crossedProviderBoundary = false;
  let knownCreatedRecordId: number | null = null;
  try {
    // Atlas exposes account-wide assets, not an upstream group API. Persist a
    // separate tenant-local grouping key solely for ownership/audit.
    let existingRecordId = claimed.atlasAssetLibraryId ??
      (claimed.atlasAssetId && /^\d+$/.test(claimed.atlasAssetId)
        ? Number(claimed.atlasAssetId)
        : null);
    if (!existingRecordId && claimed.atlasAssetSubmitFencedAt) {
      return fail(
        "Atlas submission was previously started but its asset ids were not durably saved. Automatic retry is blocked; an admin must reconcile the Atlas console before retrying.",
      );
    }
    if (
      existingRecordId &&
      claimed.atlasAssetFenceState === "compensated" &&
      !selectAtlasGenerationReferenceId(claimed.atlasAssetReferenceId, claimed.atlasAssetId)
    ) {
      try {
        await getAtlasAsset(existingRecordId, apiKey);
      } catch (error) {
        if (error instanceof AtlasAssetsError && error.status === 404) {
          const cleared = await db.transaction(async (tx) => {
            await tx.select({ id: charactersTable.id }).from(charactersTable).where(and(
              eq(charactersTable.id, args.character.id),
              eq(charactersTable.tenantId, args.tenantId),
            )).for("update").limit(1);
            await tx.select({ id: characterOutfitsTable.id }).from(characterOutfitsTable).where(and(
              eq(characterOutfitsTable.id, claimed.id),
              eq(characterOutfitsTable.characterId, args.character.id),
              eq(characterOutfitsTable.tenantId, args.tenantId),
            )).for("update").limit(1);
            const [row] = await tx.update(characterOutfitsTable).set({
              atlasAssetLibraryId: null,
              atlasAssetSubmitFencedAt: null,
              atlasAssetFenceState: null,
              atlasAssetCompensationError: null,
            }).where(and(
              eq(characterOutfitsTable.id, claimed.id),
              eq(characterOutfitsTable.characterId, args.character.id),
              eq(characterOutfitsTable.tenantId, args.tenantId),
              eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
              eq(characterOutfitsTable.atlasAssetLibraryId, existingRecordId!),
              eq(characterOutfitsTable.atlasAssetFenceState, "compensated"),
              eq(characterOutfitsTable.status, "approved"),
              eq(characterOutfitsTable.identityVerified, true),
              eq(characterOutfitsTable.referenceImagePath, args.expectedSourcePath!),
              eq(characterOutfitsTable.atlasApprovedSourceSha256, args.expectedSourceSha256!),
              eq(characterOutfitsTable.atlasAssetSourcePath, args.expectedSourcePath!),
              eq(characterOutfitsTable.atlasAssetSourceSha256, args.expectedSourceSha256!),
            )).returning();
            return row;
          });
          if (!cleared) return claimed;
          existingRecordId = null;
        } else {
          const message = error instanceof Error ? error.message : "Compensated Atlas asset absence could not be verified.";
          const [unknown] = await db.update(characterOutfitsTable).set({
            atlasAssetStatus: "Failed",
            atlasAssetClaimedAt: null,
            atlasAssetLeaseOwner: null,
            atlasAssetFenceState: "compensated",
            atlasAssetCompensationError: message.slice(0, 500),
            atlasAssetError: message.slice(0, 500),
            atlasAssetSyncedAt: new Date(),
          }).where(and(
            eq(characterOutfitsTable.id, claimed.id),
            eq(characterOutfitsTable.characterId, args.character.id),
            eq(characterOutfitsTable.tenantId, args.tenantId),
            eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
            eq(characterOutfitsTable.atlasAssetLibraryId, existingRecordId),
            eq(characterOutfitsTable.atlasAssetFenceState, "compensated"),
          )).returning();
          return unknown ?? claimed;
        }
      }
    }
    let asset: Awaited<ReturnType<typeof createAtlasAsset>> | null = null;
    if (!existingRecordId) {
      // Acquiring a signed URL is safely retryable. The durable fence is
      // intentionally written only after that work succeeds, immediately
      // before crossing the paid/provider boundary.
      const url = await storage.getSignedDownloadURL(
        claimed.referenceImagePath,
        args.tenantId,
        15 * 60,
      );
      const fenced = await db.transaction(async (tx) => {
        await tx.select({ id: charactersTable.id }).from(charactersTable).where(and(
          eq(charactersTable.id, args.character.id),
          eq(charactersTable.tenantId, args.tenantId),
        )).for("update").limit(1);
        await tx.select({ id: characterOutfitsTable.id }).from(characterOutfitsTable).where(and(
          eq(characterOutfitsTable.id, claimed.id),
          eq(characterOutfitsTable.characterId, args.character.id),
          eq(characterOutfitsTable.tenantId, args.tenantId),
        )).for("update").limit(1);
        const [row] = await tx.update(characterOutfitsTable).set({
          atlasAssetSubmitFencedAt: new Date(),
          atlasAssetFenceState: "submitting",
        }).where(and(
          eq(characterOutfitsTable.id, claimed.id),
          eq(characterOutfitsTable.characterId, args.character.id),
          eq(characterOutfitsTable.tenantId, args.tenantId),
          eq(characterOutfitsTable.atlasAssetClaimedAt, claimed.atlasAssetClaimedAt!),
          eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
          eq(characterOutfitsTable.referenceImagePath, args.expectedSourcePath!),
          eq(characterOutfitsTable.status, "approved"),
          eq(characterOutfitsTable.identityVerified, true),
          eq(characterOutfitsTable.atlasApprovedSourceSha256, args.expectedSourceSha256!),
          isNull(characterOutfitsTable.atlasAssetLibraryId),
          isNull(characterOutfitsTable.atlasAssetSubmitFencedAt),
        )).returning();
        return row;
      });
      if (!fenced) {
        const [current] = await db.select().from(characterOutfitsTable).where(and(
          eq(characterOutfitsTable.id, claimed.id),
          eq(characterOutfitsTable.tenantId, args.tenantId),
        )).limit(1);
        return current ?? claimed;
      }
      crossedProviderBoundary = true;
      asset = await createAtlasAsset(url, apiKey);
      if (Number.isInteger(asset.libraryRecordId) && asset.libraryRecordId > 0) {
        knownCreatedRecordId = asset.libraryRecordId;
      }
    }
    const recordId = existingRecordId ?? asset!.libraryRecordId;
    const [persisted] = await db.update(characterOutfitsTable).set({
      atlasAssetLibraryId: recordId,
      atlasAssetReferenceId: asset?.generationReferenceId ??
        selectAtlasGenerationReferenceId(claimed.atlasAssetReferenceId, claimed.atlasAssetId),
      atlasAssetId: asset?.generationReferenceId ??
        selectAtlasGenerationReferenceId(claimed.atlasAssetReferenceId, claimed.atlasAssetId),
      atlasAssetStatus: "Processing",
      atlasAssetError: null,
      atlasAssetSyncedAt: new Date(),
      atlasAssetSourcePath: claimed.referenceImagePath,
      atlasAssetSourceSha256: args.expectedSourceSha256 ?? null,
    }).where(and(
      eq(characterOutfitsTable.id, claimed.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
      eq(characterOutfitsTable.atlasAssetClaimedAt, claimed.atlasAssetClaimedAt!),
      eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
      eq(characterOutfitsTable.referenceImagePath, claimed.referenceImagePath),
      eq(characterOutfitsTable.status, "approved"),
      eq(characterOutfitsTable.identityVerified, true),
      eq(characterOutfitsTable.atlasApprovedSourceSha256, args.expectedSourceSha256),
    )).returning({ id: characterOutfitsTable.id });
    args.afterMappingPersistence?.();
    if (!persisted) {
      if (asset) {
        try {
          await deleteAtlasAsset(recordId, apiKey);
          const [compensated] = await db.update(characterOutfitsTable).set({
            atlasAssetLibraryId: recordId,
            atlasAssetReferenceId: null,
            atlasAssetId: null,
            atlasAssetStatus: "Failed",
            atlasAssetError: "Atlas creation was compensated after local persistence lost its lease.",
            atlasAssetSyncedAt: new Date(),
            atlasAssetClaimedAt: null,
            atlasAssetLeaseOwner: null,
            atlasAssetFenceState: "compensated",
            atlasAssetCompensationError: null,
            atlasAssetSourcePath: claimed.referenceImagePath,
            atlasAssetSourceSha256: args.expectedSourceSha256,
          }).where(and(
            eq(characterOutfitsTable.id, claimed.id),
            eq(characterOutfitsTable.tenantId, args.tenantId),
            eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
          )).returning();
          crossedProviderBoundary = false;
          return compensated ?? claimed;
        } catch (compensationError) {
          const [unknown] = await db.update(characterOutfitsTable).set({
            atlasAssetLibraryId: recordId,
            atlasAssetFenceState: "outcome_unknown",
            atlasAssetCompensationError: compensationError instanceof Error
              ? compensationError.message.slice(0, 500)
              : "Atlas compensation failed.",
          }).where(and(
            eq(characterOutfitsTable.id, claimed.id),
            eq(characterOutfitsTable.tenantId, args.tenantId),
            eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
          )).returning();
          return unknown ?? claimed;
        }
      }
      throw new Error("Atlas outfit creation succeeded but local persistence lost its fenced lease.");
    }
    knownCreatedRecordId = null;
    const result = await waitForAtlasAsset(recordId, apiKey);
    const [updated] = await db.update(characterOutfitsTable).set({
      atlasAssetLibraryId: result.libraryRecordId,
      atlasAssetReferenceId: result.generationReferenceId,
      atlasAssetId: result.generationReferenceId,
      atlasAssetStatus: result.status,
      atlasAssetError: result.error,
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: null,
      atlasAssetLeaseOwner: null,
      atlasAssetFenceState: "resolved",
      atlasAssetSourcePath: claimed.referenceImagePath,
      atlasAssetSourceSha256: args.expectedSourceSha256 ?? null,
    }).where(and(
      eq(characterOutfitsTable.id, claimed.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
      eq(characterOutfitsTable.atlasAssetClaimedAt, claimed.atlasAssetClaimedAt!),
      eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner),
      eq(characterOutfitsTable.referenceImagePath, claimed.referenceImagePath),
      eq(characterOutfitsTable.status, "approved"),
      eq(characterOutfitsTable.identityVerified, true),
      eq(characterOutfitsTable.atlasApprovedSourceSha256, args.expectedSourceSha256),
    )).returning();
    return updated!;
  } catch (error) {
    if (crossedProviderBoundary && knownCreatedRecordId !== null) {
      try {
        await deleteAtlasAsset(knownCreatedRecordId, apiKey);
        const [compensated] = await db.update(characterOutfitsTable).set({
          atlasAssetLibraryId: knownCreatedRecordId,
          atlasAssetReferenceId: null,
          atlasAssetId: null,
          atlasAssetStatus: "Failed",
          atlasAssetError: "Atlas creation was compensated after local persistence failed.",
          atlasAssetSyncedAt: new Date(),
          atlasAssetClaimedAt: null,
          atlasAssetLeaseOwner: null,
          atlasAssetFenceState: "compensated",
          atlasAssetCompensationError: null,
          atlasAssetSourcePath: args.expectedSourcePath,
          atlasAssetSourceSha256: args.expectedSourceSha256,
        }).where(and(
          eq(characterOutfitsTable.id, args.outfit.id),
          eq(characterOutfitsTable.characterId, args.character.id),
          eq(characterOutfitsTable.tenantId, args.tenantId),
          eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner!),
        )).returning();
        crossedProviderBoundary = false;
        return compensated ?? args.outfit;
      } catch (compensationError) {
        const message = compensationError instanceof Error
          ? compensationError.message
          : "Atlas compensation failed.";
        const [unknown] = await db.update(characterOutfitsTable).set({
          atlasAssetLibraryId: knownCreatedRecordId,
          atlasAssetFenceState: "outcome_unknown",
          atlasAssetCompensationError: message.slice(0, 500),
          atlasAssetError: (error instanceof Error ? error.message : "Local Atlas persistence failed.").slice(0, 500),
          atlasAssetSyncedAt: new Date(),
        }).where(and(
          eq(characterOutfitsTable.id, args.outfit.id),
          eq(characterOutfitsTable.characterId, args.character.id),
          eq(characterOutfitsTable.tenantId, args.tenantId),
          eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner!),
        )).returning();
        return unknown ?? args.outfit;
      }
    }
    if (
      crossedProviderBoundary &&
      (!(error instanceof AtlasAssetsError) ||
        error.status === undefined ||
        error.status >= 500)
    ) {
      const message = error instanceof Error ? error.message : "Atlas submission outcome is unknown.";
      const [unknown] = await db.update(characterOutfitsTable).set({
        atlasAssetFenceState: "outcome_unknown",
        atlasAssetError: message.slice(0, 500),
        atlasAssetSyncedAt: new Date(),
      }).where(and(
        eq(characterOutfitsTable.id, args.outfit.id),
        eq(characterOutfitsTable.characterId, args.character.id),
        eq(characterOutfitsTable.tenantId, args.tenantId),
        eq(characterOutfitsTable.atlasAssetLeaseOwner, leaseOwner!),
        eq(characterOutfitsTable.referenceImagePath, args.expectedSourcePath),
        eq(characterOutfitsTable.atlasApprovedSourceSha256, args.expectedSourceSha256),
        eq(characterOutfitsTable.status, "approved"),
        eq(characterOutfitsTable.identityVerified, true),
      )).returning();
      return unknown ?? args.outfit;
    }
    return fail(error instanceof Error ? error.message : "Atlas Cloud asset registration failed.");
  }
}

export function registerAtlasOutfitAssetInBackground(args: {
  tenantId: number;
  character: Character;
  outfit: CharacterOutfit;
}): void {
  // Rejected sources are persisted as an explicit policy failure without ever
  // obtaining a signed URL or crossing the provider boundary.
  void registerAtlasOutfitAsset(args).catch((error) =>
    logger.warn(
      { err: error, characterId: args.character.id, outfitId: args.outfit.id },
      "Atlas Cloud asset registration failed",
    ));
}

type AtlasRegistrationArgs = {
  tenantId: number;
  characterId: number;
  outfitId?: number;
  expectedReferenceSheetPath?: string;
  expectedOutfitPath?: string;
  expectedReferenceSheetSha256?: string;
  expectedOutfitSha256?: string;
};
export function registerAtlasCharacterAssets(
  args: AtlasRegistrationArgs & { outfitId: number },
): Promise<{ character: Character; outfit: CharacterOutfit }>;
export function registerAtlasCharacterAssets(
  args: AtlasRegistrationArgs & { outfitId?: undefined },
): Promise<{ character: Character; outfit?: undefined }>;
export async function registerAtlasCharacterAssets(
  args: AtlasRegistrationArgs,
): Promise<{ character: Character; outfit?: CharacterOutfit }> {
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, args.characterId),
    eq(charactersTable.tenantId, args.tenantId),
  )).limit(1);
  if (!character) throw new Error("The selected Guided Story character was deleted.");
  const expectedReferenceSheetPath = args.expectedReferenceSheetPath ??
    character.referenceSheetImagePath ?? undefined;
  const freshReferenceSheetSha256 = expectedReferenceSheetPath
    ? await atlasSourceSha256(expectedReferenceSheetPath, args.tenantId)
    : undefined;
  if (
    args.expectedReferenceSheetSha256 !== undefined &&
    args.expectedReferenceSheetSha256 !== freshReferenceSheetSha256
  ) {
    throw new Error("The character reference sheet bytes changed before Atlas registration. Review and approve it again.");
  }
  const expectedReferenceSheetSha256 = freshReferenceSheetSha256;
  const registeredCharacter = await registerAtlasCharacterAsset({
    tenantId: args.tenantId,
    character,
    expectedReferenceSheetPath,
    expectedSourceSha256: expectedReferenceSheetSha256,
  });
  if (
    registeredCharacter.atlasAssetStatus !== "Active" ||
    !registeredCharacter.atlasAssetLibraryId ||
    !selectAtlasGenerationReferenceId(
      registeredCharacter.atlasAssetReferenceId,
      registeredCharacter.atlasAssetId,
    )
  ) {
    throw new Error(registeredCharacter.atlasAssetError ??
      "Atlas character registration did not become active. Retry after checking Atlas Asset Library status.");
  }
  // This API deliberately does not turn a parent-only request into a bulk
  // outfit registration.  A caller that needs an ordered pair must name it.
  if (args.outfitId === undefined) return { character: registeredCharacter };
  const outfits = await db.select().from(characterOutfitsTable).where(and(
    eq(characterOutfitsTable.characterId, character.id),
    eq(characterOutfitsTable.tenantId, args.tenantId),
    ...(args.outfitId !== undefined
      ? [eq(characterOutfitsTable.id, args.outfitId)]
      : []),
  ));
  if (outfits.length !== 1 && args.outfitId !== undefined) {
    throw new Error("The selected Guided Story outfit was deleted.");
  }
  for (const outfit of outfits) {
    if (
      args.expectedOutfitPath !== undefined &&
      outfit.referenceImagePath !== args.expectedOutfitPath
    ) {
      throw new Error("The approved outfit reference changed before Atlas registration. Review and approve it again.");
    }
    const freshOutfitSha256 = await atlasSourceSha256(outfit.referenceImagePath, args.tenantId);
    if (
      args.expectedOutfitSha256 !== undefined &&
      args.expectedOutfitSha256 !== freshOutfitSha256
    ) {
      throw new Error("The outfit reference bytes changed before Atlas registration. Review and approve it again.");
    }
    const registered = await registerAtlasOutfitAsset({
      tenantId: args.tenantId,
      character: registeredCharacter,
      outfit,
      expectedSourcePath: args.expectedOutfitPath,
      expectedSourceSha256: freshOutfitSha256,
    });
    if (
      registered.atlasAssetStatus !== "Active" ||
      !registered.atlasAssetLibraryId ||
      !selectAtlasGenerationReferenceId(registered.atlasAssetReferenceId, registered.atlasAssetId)
    ) {
      throw new Error(registered.atlasAssetError ??
        "Atlas outfit registration did not become active. Retry after checking Atlas Asset Library status.");
    }
    if (args.outfitId !== undefined) {
      return { character: registeredCharacter, outfit: registered };
    }
  }
  throw new Error("No approved Guided Story outfit was available for Atlas registration.");
}

/** Resolve only active Atlas mappings; callers decide whether absence is fatal. */
export async function atlasAssetRefsForOutfit(args: {
  tenantId: number;
  characterId: number;
  outfitId: number;
  expectedCharacterLibraryId: number;
  expectedCharacterReferenceId: string;
  expectedReferenceSheetPath: string;
  expectedReferenceSheetSha256: string;
  expectedOutfitLibraryId: number;
  expectedOutfitAssetId: string;
  expectedOutfitPath: string;
  expectedOutfitSha256: string;
}): Promise<string[]> {
  const [freshReferenceSheetSha256, freshOutfitSha256] = await Promise.all([
    atlasSourceSha256(args.expectedReferenceSheetPath, args.tenantId),
    atlasSourceSha256(args.expectedOutfitPath, args.tenantId),
  ]);
  if (
    freshReferenceSheetSha256 !== args.expectedReferenceSheetSha256 ||
    freshOutfitSha256 !== args.expectedOutfitSha256
  ) return [];
  return db.transaction(async (tx) => {
    const [character] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, args.characterId),
      eq(charactersTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    const characterReferenceId = character && selectAtlasGenerationReferenceId(
      character.atlasAssetReferenceId,
      character.atlasAssetId,
    );
    if (
      !character ||
      character.referenceSource !== "generated" ||
      character.bytePlusIdentityId !== null ||
      character.referenceSheetStatus !== "approved" ||
      character.referenceSheetImagePath !== args.expectedReferenceSheetPath ||
      character.referenceSheetApprovedSha256 !== args.expectedReferenceSheetSha256 ||
      character.atlasAssetSourcePath !== args.expectedReferenceSheetPath ||
      character.atlasAssetSourceSha256 !== args.expectedReferenceSheetSha256 ||
      character.atlasAssetStatus !== "Active" ||
      character.atlasAssetLibraryId !== args.expectedCharacterLibraryId ||
      characterReferenceId !== args.expectedCharacterReferenceId
    ) return [];
    const [outfit] = await tx.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.id, args.outfitId),
      eq(characterOutfitsTable.characterId, args.characterId),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    const outfitReferenceId = outfit && selectAtlasGenerationReferenceId(
      outfit.atlasAssetReferenceId,
      outfit.atlasAssetId,
    );
    if (
      !outfit ||
      outfit.status !== "approved" ||
      !outfit.identityVerified ||
      outfit.referenceImagePath !== args.expectedOutfitPath ||
      outfit.atlasApprovedSourceSha256 !== args.expectedOutfitSha256 ||
      outfit.atlasAssetSourcePath !== args.expectedOutfitPath ||
      outfit.atlasAssetSourceSha256 !== args.expectedOutfitSha256 ||
      outfit.atlasAssetStatus !== "Active" ||
      outfit.atlasAssetLibraryId !== args.expectedOutfitLibraryId ||
      outfitReferenceId !== args.expectedOutfitAssetId
    ) return [];
    return [outfitReferenceId];
  });
}

/**
 * User deletion still requires affirmative GET absence. Provider DELETE is
 * reserved for immediate compensation of a newly-created, numeric record;
 * network/auth ambiguity deliberately blocks local deletion.
 */
export async function assertAtlasAssetsDeleted(
  assets: Array<{
    libraryRecordId: number | null;
    historicalId?: string | null;
    submitFencedAt?: Date | null;
  }>,
): Promise<void> {
  if (assets.some((asset) => asset.submitFencedAt && !asset.libraryRecordId)) {
    throw new Error(
      "An Atlas submission was fenced but has no numeric Asset Library record id. Reconcile the Atlas console before deletion; deletion is blocked to prevent an upstream orphan.",
    );
  }
  const unresolved = assets.filter((asset) => asset.historicalId && !asset.libraryRecordId);
  if (unresolved.length) {
    throw new Error(
      "A legacy Atlas mapping has no numeric Asset Library record id. An admin must reconcile or remove it in the Atlas console before deletion.",
    );
  }
  const assetIds = [...new Set(assets
    .map((asset) => asset.libraryRecordId)
    .filter((id): id is number => id !== null))];
  if (!assetIds.length) return;
  const apiKey = await resolveAtlasAssetsKey();
  if (!apiKey) {
    throw new Error("Atlas Cloud credentials are required to verify asset deletion; remove the assets in the Atlas console first.");
  }
  const existing: Array<{ id: number; status: string }> = [];
  await Promise.all(assetIds.map(async (id) => {
    try {
      const asset = await getAtlasAsset(id, apiKey);
      existing.push({ id, status: asset.status });
    } catch (error) {
      // The documented GET 404 is the only affirmative absence signal.
      if (error instanceof Error && "status" in error && (error as { status?: number }).status === 404) {
        return;
      }
      throw error;
    }
  }));
  if (existing.length) {
    const detail = existing.map(({ id, status }) => `${id} (${status})`).join(", ");
    throw new Error(
      `Atlas Cloud asset${existing.length === 1 ? "" : "s"} ${detail} still exist${existing.length === 1 ? "s" : ""}. Remove ${existing.length === 1 ? "it" : "them"} in the Atlas console before deleting this character or outfit.`,
    );
  }
}