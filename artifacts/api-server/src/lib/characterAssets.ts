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
  getAtlasAsset,
  resolveAtlasAssetsKey,
  waitForAtlasAsset,
} from "./atlascloud/assets";

const storage = new ObjectStorageService();

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

/** Register one tenant-owned, approved fictional outfit under a ten-minute lease. */
export async function registerAtlasOutfitAsset(args: {
  tenantId: number;
  character: Character;
  outfit: CharacterOutfit;
}): Promise<CharacterOutfit> {
  const policyError = atlasRegistrationSourceError(args.character, args.outfit);
  const failWithoutClaim = async (message: string): Promise<CharacterOutfit> => {
    const [updated] = await db.update(characterOutfitsTable).set({
      atlasAssetStatus: "Failed",
      atlasAssetError: message.slice(0, 500),
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: null,
    }).where(and(
      eq(characterOutfitsTable.id, args.outfit.id),
      eq(characterOutfitsTable.characterId, args.character.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).returning();
    return updated ?? args.outfit;
  };
  if (policyError) return failWithoutClaim(policyError);
  if (args.outfit.atlasAssetStatus === "Active") return args.outfit;

  const stale = new Date(Date.now() - 10 * 60_000);
  const [claimed] = await db.update(characterOutfitsTable).set({
    atlasAssetStatus: "Processing",
    atlasAssetClaimedAt: new Date(),
  }).where(and(
    eq(characterOutfitsTable.id, args.outfit.id),
    eq(characterOutfitsTable.characterId, args.character.id),
    eq(characterOutfitsTable.tenantId, args.tenantId),
    or(
      isNull(characterOutfitsTable.atlasAssetStatus),
      eq(characterOutfitsTable.atlasAssetStatus, "Failed"),
      and(
        eq(characterOutfitsTable.atlasAssetStatus, "Processing"),
        or(
          isNull(characterOutfitsTable.atlasAssetClaimedAt),
          lt(characterOutfitsTable.atlasAssetClaimedAt, stale),
        ),
      ),
    ),
  )).returning();
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

  try {
    // Atlas exposes account-wide assets, not an upstream group API. Persist a
    // separate tenant-local grouping key solely for ownership/audit.
    const groupId = args.character.atlasAssetGroupId ??
      `tenant-${args.tenantId}-character-${args.character.id}`;
    if (!args.character.atlasAssetGroupId) {
      await db.update(charactersTable).set({ atlasAssetGroupId: groupId }).where(and(
        eq(charactersTable.id, args.character.id),
        eq(charactersTable.tenantId, args.tenantId),
        isNull(charactersTable.atlasAssetGroupId),
      ));
    }
    const assetId =
      args.outfit.atlasAssetStatus === "Processing" && claimed.atlasAssetId
        ? claimed.atlasAssetId
        : await createAtlasAsset(
            await storage.getSignedDownloadURL(claimed.referenceImagePath, args.tenantId, 15 * 60),
            apiKey,
          );
    await db.update(characterOutfitsTable).set({
      atlasAssetId: assetId,
      atlasAssetStatus: "Processing",
      atlasAssetError: null,
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: new Date(),
    }).where(and(
      eq(characterOutfitsTable.id, claimed.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    ));
    const result = await waitForAtlasAsset(assetId, apiKey);
    const [updated] = await db.update(characterOutfitsTable).set({
      atlasAssetStatus: result.status,
      atlasAssetError: result.error,
      atlasAssetSyncedAt: new Date(),
      atlasAssetClaimedAt: null,
    }).where(and(
      eq(characterOutfitsTable.id, claimed.id),
      eq(characterOutfitsTable.tenantId, args.tenantId),
    )).returning();
    return updated!;
  } catch (error) {
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

export async function registerAtlasCharacterAssets(args: {
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
    await registerAtlasOutfitAsset({ tenantId: args.tenantId, character, outfit });
  }
}

/** Resolve only active Atlas mappings; callers decide whether absence is fatal. */
export async function atlasAssetRefsForOutfit(args: {
  tenantId: number;
  characterId: number;
  outfitId: number;
  /** Frozen enqueue/approval-time id; a replaced mapping must not drift a retry. */
  expectedAssetId?: string | null;
}): Promise<string[]> {
  const [outfit] = await db.select({
    assetId: characterOutfitsTable.atlasAssetId,
    status: characterOutfitsTable.atlasAssetStatus,
  }).from(characterOutfitsTable).where(and(
    eq(characterOutfitsTable.id, args.outfitId),
    eq(characterOutfitsTable.characterId, args.characterId),
    eq(characterOutfitsTable.tenantId, args.tenantId),
  )).limit(1);
  if (
    outfit?.status !== "Active" ||
    !outfit.assetId ||
    (args.expectedAssetId !== undefined && outfit.assetId !== args.expectedAssetId)
  ) return [];
  return [outfit.assetId];
}

/**
 * Atlas has no confirmed DELETE endpoint. We must prove every registered
 * remote asset is already absent before deleting the local ownership record.
 * Network/auth ambiguity deliberately blocks deletion rather than orphaning.
 */
export async function assertAtlasAssetsDeleted(ids: Array<string | null>): Promise<void> {
  const assetIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!assetIds.length) return;
  const apiKey = await resolveAtlasAssetsKey();
  if (!apiKey) {
    throw new Error("Atlas Cloud credentials are required to verify asset deletion; remove the assets in the Atlas console first.");
  }
  const existing: Array<{ id: string; status: string }> = [];
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