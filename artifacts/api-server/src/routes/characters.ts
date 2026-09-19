import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  db,
  tenantsTable,
  charactersTable,
  characterOutfitsTable,
  presetCharactersTable,
  presetOutfitDerivativesTable,
  guidedStoryDraftsTable,
  walletProviderOperationsTable,
  characterLikenessConsentGrantsTable,
  characterLikenessConsentRevocationsTable,
  characterLikenessRecipientDisclosuresTable,
  characterLikenessRecipientRevocationsTable,
  tenantLikenessStandingDeclarationsTable,
} from "@workspace/db";
import type {
  Character,
  CharacterOutfit,
  LikenessRecipientOperation,
  LikenessSubjectClass,
  PresetCharacter,
} from "@workspace/db";
import { and, eq, asc, desc, inArray, sql, isNull } from "drizzle-orm";
import {
  CreateCharacterBody,
  CreateCharacterOutfitBody,
  UpdateCharacterBody,
  UpdateCharacterOutfitBody,
  UpdatePresetOutfitDerivativeBody,
  StartBytePlusIdentityVerificationBody,
  GrantCharacterLikenessConsentBody,
  RevokeCharacterLikenessConsentBody,
} from "@workspace/api-zod";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import {
  isWalletFunded,
  reserveWallet,
  executeWalletProviderOperation,
  settleWalletProviderOperationDurably,
  refundWallet,
  type WalletReservation,
  WalletProviderSuccessPersistenceError,
  WalletProviderPostSuccessError,
} from "../lib/wallet";
import { recordUsage } from "../lib/usage";
import { uploadBufferToStorage } from "../lib/storageUpload";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  CharacterInputError,
  loadReferenceImage,
  generateCharacterReference,
  generateCharacterReferenceSheet,
  generateOutfitVariant,
  createOutfitMaskedEdit,
} from "../lib/characters";
import {
  ImageGenNotConfiguredError,
  ImageGenOutputValidationError,
  ImageGenProviderError,
  ImagePreservationError,
} from "../lib/imageGen/types";
import {
  CharacterVisualQaError,
  characterVisualQaFailureCategory,
  describeCharacterVisualQaFailure,
  type CharacterVisualQaFailureCategory,
} from "../lib/characterVisualQa";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { canonicalAppOrigin } from "../lib/corsOrigins";
import {
  ensurePresetCharacterSeeds,
  bundledPresetAsset,
  getPresetForTenant,
  listTenantPresetDerivatives,
} from "../lib/presetCharacters";
import {
  assertAtlasAssetsDeleted,
  deleteBytePlusAssetsInBackground,
  registerOutfitAssetInBackground,
} from "../lib/characterAssets";
import {
  BytePlusIdentityConflictError,
  completeBytePlusIdentityVerification,
  deleteBytePlusIdentity,
  deleteBytePlusIdentityAssetsInBackground,
  getBytePlusIdentity,
  listBytePlusIdentities,
  startBytePlusIdentityVerification,
} from "../lib/bytePlusIdentity";
import { freezeMeterFunding, type MeterFundingSnapshot } from "../lib/meterFunding";
import { InsufficientCreditsError } from "../lib/creditAccounts";
import { isMeterDispatchReplayError } from "../lib/meterErrors";
import {
  captureAssetProvenance,
  sha256Hex,
  validateExactRecoveryEvidence,
  type ProvenanceSummary,
} from "../lib/provenance";
import {
  LIKENESS_CONSENT_POLICY_VERSION,
  isPersonalLikenessSource,
  likenessConsentStatement,
  routingSubjectClassFor,
  standingDeclarationEnforced,
  tenantStandingDeclarationStatement,
} from "../lib/provenancePolicy";
import {
  effectiveModel,
  getImageGenProviderDef,
  getImageGenSelection,
  IMAGE_GEN_AUTO,
  supportsReferenceInput,
} from "../lib/imageGen";
import {
  assertFrozenPersonalImageConsent,
  freezePersonalImageConsent,
  latestGrant,
  latestStandingDeclaration,
  PersonalLikenessConsentError,
  validateLikenessGrantAttestation,
  hasOnlyLikenessConsentRequestKeys,
} from "../lib/likenessConsent";
import {
  PROVIDER_LIKENESS_DECLARATIONS,
  recipientScopeLabel,
  resolveLikenessRouting,
} from "../lib/likenessProviderPolicy";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

class AtlasDeletionRaceError extends Error {}

function hasBlockingAtlasWork(row: {
  atlasAssetClaimedAt: Date | null;
  atlasAssetLeaseOwner: string | null;
  atlasAssetSubmitFencedAt: Date | null;
  atlasAssetFenceState: "submitting" | "outcome_unknown" | "resolved" | "compensated" | null;
}): boolean {
  return Boolean(
    row.atlasAssetClaimedAt ||
    row.atlasAssetLeaseOwner ||
    (row.atlasAssetSubmitFencedAt &&
      row.atlasAssetFenceState !== "resolved" &&
      row.atlasAssetFenceState !== "compensated"),
  );
}

function atlasDeletionSnapshot(outfits: Array<Pick<CharacterOutfit,
  "id" | "atlasAssetLibraryId" | "atlasAssetReferenceId" | "atlasAssetId" |
  "atlasAssetStatus" | "atlasAssetClaimedAt" | "atlasAssetLeaseOwner" |
  "atlasAssetSubmitFencedAt" | "atlasAssetFenceState" | "atlasAssetSourcePath" |
  "atlasAssetSourceSha256" | "atlasAssetCompensationError" | "atlasAssetSyncedAt"
>>): string {
  return JSON.stringify([...outfits]
    .sort((a, b) => a.id - b.id)
    .map((outfit) => ({
      id: outfit.id,
      libraryRecordId: outfit.atlasAssetLibraryId,
      referenceId: outfit.atlasAssetReferenceId,
      compatibilityId: outfit.atlasAssetId,
      status: outfit.atlasAssetStatus,
      claimedAt: outfit.atlasAssetClaimedAt?.toISOString() ?? null,
      leaseOwner: outfit.atlasAssetLeaseOwner,
      submitFencedAt: outfit.atlasAssetSubmitFencedAt?.toISOString() ?? null,
      fenceState: outfit.atlasAssetFenceState,
      sourcePath: outfit.atlasAssetSourcePath,
      sourceSha256: outfit.atlasAssetSourceSha256,
      compensationError: outfit.atlasAssetCompensationError,
      syncedAt: outfit.atlasAssetSyncedAt?.toISOString() ?? null,
    })));
}

/** Bundled fictional references; browser path is /api + stored asset path. */
router.get("/preset-assets/:presetId/:asset", (req, res) => {
  const asset = bundledPresetAsset(String(req.params.presetId), String(req.params.asset));
  if (!asset) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=31536000, immutable").send(asset);
});

export function isConfirmedImageFailure(error: unknown): boolean {
  // A consent callback runs immediately before the adapter POST. It is a
  // definitive local refusal, not an ambiguous upstream outcome, so any
  // pre-reserved wallet/quota funding must be released.
  if (error instanceof PersonalLikenessConsentError) return true;
  if (error instanceof ImagePreservationError) {
    return !error.providerWorkCompleted;
  }
  if (
    error instanceof ImageGenNotConfiguredError ||
    error instanceof CharacterInputError ||
    error instanceof ImageGenOutputValidationError ||
    error instanceof CharacterVisualQaError
  ) {
    return true;
  }
  return (
    error instanceof ImageGenProviderError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 425, 429].includes(error.status)
  );
}

function visualQaFailureKind(
  error: unknown,
): CharacterVisualQaError["kind"] | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof CharacterVisualQaError) return current.kind;
    if (typeof current !== "object" || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  // Keep the route safe if a caller supplied validator predates the typed
  // CharacterVisualQaError cause. Classification only selects fixed UX copy;
  // it never forwards the validator's/provider's message.
  if (error instanceof ImageGenOutputValidationError) {
    if (/\bmultiple people\b|exactly one|single.person|full[- ]body/i.test(error.message)) {
      return "invalid";
    }
    return "unavailable";
  }
  return null;
}

function visualQaFailureCategory(error: unknown): CharacterVisualQaFailureCategory | null {
  const kind = visualQaFailureKind(error);
  return kind ? characterVisualQaFailureCategory(kind) : null;
}

function safeImageFailureLog(error: unknown): {
  errorName: string;
  category?: CharacterVisualQaFailureCategory;
  providerStatus?: number;
} {
  const category = visualQaFailureCategory(error);
  const providerStatus =
    error instanceof ImageGenProviderError && Number.isInteger(error.status)
      ? error.status
      : undefined;
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    ...(category ? { category } : {}),
    ...(providerStatus === undefined ? {} : { providerStatus }),
  };
}

/**
 * Translate the machine visual gate into stable UX language. In particular,
 * never pass through the provider or vision response: those details can
 * contain implementation data and are not actionable to a customer.
 */
export function characterVisualQaErrorMessage(
  error: unknown,
  draftId?: number,
  mode: "primary" | "sheet" | "outfit" = "primary",
): string | null {
  const kind = visualQaFailureKind(error);
  if (!kind) return null;
  const draftSuffix =
    draftId == null ? "" : ` for Guided Story draft ${draftId} (draft ID ${draftId})`;
  const described = describeCharacterVisualQaFailure(error, mode);
  if (described) {
    return `${described.reason}${draftSuffix}`;
  }
  // A validator supplied by an older caller may preserve only the wrapper
  // message, not its typed QA cause. Keep that path safe and mode-specific.
  if (mode === "sheet") {
    const category = characterVisualQaFailureCategory(kind);
    if (category === "invalid") {
      return `Reference sheet visual QA (invalid): the five-panel identity and design checks did not pass. No reference sheet was saved${draftSuffix}.`;
    }
    if (category === "uncertain") {
      return `Reference sheet visual QA (uncertain): the required visual checks could not be confirmed. No reference sheet was saved${draftSuffix}.`;
    }
    return `Reference sheet visual QA (unavailable): the machine visual checks could not be completed. No reference sheet was saved${draftSuffix}. Try again later.`;
  }
  if (kind === "invalid") {
    return `The generated portrait did not pass the single-person visual check (multiple people or an incomplete frame). No portrait was saved${draftSuffix}.`;
  }
  return `Portrait visual validation is unavailable or inconclusive. No portrait was saved${draftSuffix}. Try again later.`;
}

/** Per-tenant cap: characters are curated identities, not a media library. */
export const MAX_CHARACTERS = 30;

/**
 * Characters: reusable, tenant-scoped identities for the Video Studio.
 * Creating a character from a description — and every costume variant — is
 * an AI image generation, so those calls fund exactly like /ai/generate-image
 * (image quota first, then an atomically reserved image credit).
 */

function serializeOutfit(outfit: CharacterOutfit) {
  return {
    id: outfit.id,
    name: outfit.name,
    description: outfit.description,
    referenceImagePath: outfit.referenceImagePath,
    isDefault: outfit.isDefault,
    status: outfit.status,
    identityVerified: outfit.identityVerified,
    canonicalReferenceImagePath: outfit.canonicalReferenceImagePath,
    protectedRegion: outfit.protectedRegion,
  };
}

function legacyCreationProvenance(character: Character): {
  status: "verified_generated" | "uploaded" | "unknown";
  summary: ProvenanceSummary;
} {
  if (character.referenceSource === "uploaded") {
    return {
      status: "uploaded",
      summary: {
        method: "upload",
        provider: null,
        model: null,
        createdAt: character.createdAt.toISOString(),
      },
    };
  }
  const evidence = character.creationEvidence;
  if (
    character.referenceSource === "generated" &&
    evidence?.version === 1 &&
    evidence.sourcePath === character.referenceImagePath &&
    /^[a-f0-9]{64}$/i.test(evidence.sourceSha256) &&
    evidence.provider &&
    evidence.model
  ) {
    return {
      status: "verified_generated",
      summary: {
        method: evidence.method ?? "textgenerated",
        provider: evidence.provider,
        model: evidence.model,
        createdAt: evidence.recordedAt,
      },
    };
  }
  return {
    status: "unknown",
    summary: {
      method: "derived",
      provider: null,
      model: null,
      createdAt: null,
      missingReason: "No server-authored origin evidence is recorded.",
    },
  };
}

function serializeCharacter(character: Character, outfits: CharacterOutfit[]) {
  const ordered = [...outfits].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id,
  );
  const provenance = legacyCreationProvenance(character);
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    referenceImagePath: character.referenceImagePath,
    referenceSource: character.referenceSource,
    provenanceStatus: provenance.status,
    provenanceSummary: provenance.summary,
    identityId: character.bytePlusIdentityId,
    referenceSheetImagePath: character.referenceSheetImagePath,
    referenceSheetStatus: character.referenceSheetStatus,
    referenceSheetError: character.referenceSheetError,
    protectedRegion: character.protectedRegion,
    outfits: ordered.map(serializeOutfit),
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
  };
}

export interface ImageFunding {
  source: "quota" | "credit" | "wallet" | "credits";
  reservation?: WalletReservation;
  /** New synchronous actions must not reuse an earlier successful receipt. */
  operationId?: string;
  /** Frozen rail/mode carried into the provider-bound image meter. */
  meterFunding: MeterFundingSnapshot;
}

type Funding = ImageFunding;

function characterImageOperationKey(funding: Funding, key: string): string {
  return funding.source === "credits" && funding.operationId
    ? `${key}:${funding.operationId}`
    : key;
}

/**
 * Reserve image funding on whichever rail this workspace is on: the rupee
 * wallet, unified credits, or the original quota-then-credit path.
 * Unified credits reserve and settle at the innermost provider meter.
 * Null → caller 402s.
 */
export async function reserveImageFunding(
  req: Request,
  pinnedRecipient?: { provider: string; model: string },
): Promise<Funding | null> {
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) return null;
  // Select once before touching a legacy balance. The provider meter reserves
  // the saved rate before dispatch, and owns settlement/refunds for credits.
  const snapshot = await freezeMeterFunding(req.tenantId);
  const mode = snapshot.mode;
  if (snapshot.rail === "credits") {
    return {
      source: "credits",
      meterFunding: snapshot,
      operationId: randomUUID(),
    };
  }
  const funded = (
    source: Funding["source"],
    reservation?: WalletReservation,
  ): Funding => ({
    source,
    ...(reservation ? { reservation } : {}),
    meterFunding: Object.freeze({
      rail: source,
      mode,
      tenantId: req.tenantId,
    }),
  });
  if (await isWalletFunded(req.tenantId)) {
    // A consented personal edit must reserve against the identical frozen
    // recipient. Never price it against a later admin-selected default.
    const reservation = await reserveWallet(
      req.tenantId,
      "image",
      pinnedRecipient ?? {},
    );
    return reservation ? funded("wallet", reservation) : null;
  }
  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.images === -1 || usage.images < limits.images) return funded("quota");
  if (await spendCredit(req.tenantId, "image")) return funded("credit");
  return null;
}

export async function settleImageFunding(
  req: Request,
  funding: Funding,
  meta: { durationMs: number; responseBytes: number; model: string; provider: string },
  operationId?: number,
  usageIdempotencyKey?: string,
): Promise<void> {
  if (funding.source === "wallet" && funding.reservation) {
    if (!operationId) {
      throw new Error("Wallet-funded character image is missing its provider operation");
    }
    await settleWalletProviderOperationDurably(operationId);
  }
  await recordUsage(req.tenantId, "image", {
    ...meta,
    funding: funding.source,
    idempotencyKey: usageIdempotencyKey,
  }).catch((err) =>
    req.log.error({ err }, "Failed to record character image usage after successful work"),
  );
}

export async function releaseImageFunding(req: Request, funding: Funding): Promise<void> {
  if (funding.source === "wallet" && funding.reservation) {
    await refundWallet(
      req.tenantId,
      funding.reservation,
      "character image generation failed",
    ).catch((err) => req.log.error({ err }, "Failed to refund character image wallet"));
    return;
  }
  if (funding.source !== "credit") return;
  await refundCredits(req.tenantId, "image", 1, "character image generation failed").catch(
    (err) => req.log.error({ err }, "Failed to refund character image credit"),
  );
}

function imageErrorStatus(err: unknown): { status: number; error: string } {
  if (err instanceof InsufficientCreditsError) return { status: 402, error: err.message };
  if (isMeterDispatchReplayError(err)) return { status: 409, error: err.message };
  if (err instanceof CharacterInputError) return { status: 400, error: err.message };
  if (err instanceof PersonalLikenessConsentError) return { status: 409, error: err.message };
  const visualQaError = characterVisualQaErrorMessage(err);
  if (visualQaError) return { status: 502, error: visualQaError };
  if (err instanceof ImageGenNotConfiguredError) {
    return { status: 503, error: "Image generation is not configured. Contact your admin." };
  }
  if (err instanceof ImageGenProviderError) {
    return { status: 502, error: "The image provider rejected the request. Please try again." };
  }
  if (err instanceof ImagePreservationError) {
    return {
      status: 502,
      error:
        "The outfit could not be aligned while keeping the protected identity unchanged. No preview was saved.",
    };
  }
  return { status: 500, error: "Something went wrong. Please try again." };
}

const REFERENCE_SHEET_RETRY_MESSAGE =
  "The character was saved, but its reference sheet could not be generated. Retry from the character manager.";

/**
 * Generate and persist a character's separate review sheet. Approval is
 * revoked before provider work starts, so stale sheets can never remain castable.
 */
async function generateAndPersistReferenceSheet(
  req: Request,
  character: Character,
): Promise<Character> {
  const cleared = await db.transaction(async (tx) => {
    const [lockedCharacter] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, character.id),
      eq(charactersTable.tenantId, req.tenantId),
    )).for("update").limit(1);
    if (!lockedCharacter) return false;
    const lockedOutfits = await tx.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.characterId, character.id),
      eq(characterOutfitsTable.tenantId, req.tenantId),
    )).orderBy(asc(characterOutfitsTable.id)).for("update");
    if (
      hasBlockingAtlasWork(lockedCharacter) ||
      lockedOutfits.some(hasBlockingAtlasWork)
    ) return false;
    await tx.update(charactersTable).set({
      referenceSheetImagePath: null,
      referenceSheetStatus: "pending",
      referenceSheetApprovedSha256: null,
      referenceSheetError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(charactersTable.id, character.id),
      eq(charactersTable.tenantId, req.tenantId),
    ));
    return true;
  });
  if (!cleared) {
    throw new CharacterInputError("Atlas registration is active; reference-sheet edits are temporarily locked.");
  }

  let funding: Funding | null = null;
  let successfulAiWork = false;
  const startedAt = Date.now();
  try {
    const primaryReference = await loadReferenceImage(
      character.referenceImagePath,
      req.tenantId,
    );
    const likenessGate = await personalImageDispatchGate(
      character,
      sha256Hex(primaryReference.buffer),
      "reference_sheet",
    );
    funding = await reserveImageFunding(req, likenessGate.pinnedRecipient);
    if (!funding) {
      throw new CharacterInputError(
        "Image funding is unavailable. Add image credits or recharge, then retry.",
      );
    }
    const reservedFunding = funding;
    const generated =
      funding.source === "wallet" && funding.reservation
        ? await executeWalletProviderOperation(
            {
              tenantId: req.tenantId,
              reservation: funding.reservation,
              operationKind: "character_reference",
              operationKey: `character-reference-sheet:${character.id}:${funding.reservation.id}`,
              settlement: {
                kind: "image",
                costPaise: null,
                refKind: "character",
                refId: String(character.id),
              },
            },
            () => generateCharacterReferenceSheet(character, primaryReference, {
              tenantId: req.tenantId,
              refKind: "character",
              refId: String(character.id),
              operationKey: characterImageOperationKey(reservedFunding, `character-reference-sheet:${character.id}`),
              funding: reservedFunding.meterFunding,
            }, likenessGate.selectionPolicy, likenessGate.beforeProviderDispatch),
            (result) => ({ provider: result.provider, model: result.model }),
            { isFailureConfirmed: isConfirmedImageFailure },
          )
        : null;
    const result =
      generated?.value ??
      (await generateCharacterReferenceSheet(character, primaryReference, {
        tenantId: req.tenantId,
        refKind: "character",
        refId: String(character.id),
        operationKey: characterImageOperationKey(reservedFunding, `character-reference-sheet:${character.id}`),
        funding: reservedFunding.meterFunding,
      }, likenessGate.selectionPolicy, likenessGate.beforeProviderDispatch));
    successfulAiWork = true;
    await settleImageFunding(
      req,
      funding,
      {
        durationMs: Date.now() - startedAt,
        responseBytes: result.buffer.length,
        model: result.model,
        provider: result.provider,
      },
      generated?.operationId,
    );
    const referenceSheetImagePath = await uploadBufferToStorage(
      req.tenantId,
      result.buffer,
      "image/png",
    );
    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(charactersTable)
        .set({
          referenceSheetImagePath,
          referenceSheetStatus: "pending",
          referenceSheetApprovedSha256: null,
          referenceSheetError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(charactersTable.id, character.id),
            eq(charactersTable.tenantId, req.tenantId),
          ),
        )
        .returning();
      if (!row) return [];
      await captureAssetProvenance(tx, {
        tenantId: req.tenantId,
        assetKind: "reference_sheet",
        sourceKind: "imageedit",
        characterId: character.id,
        operationIdentity:
          `character-library:${character.id}:reference-sheet:${result.provider}:${result.model}:` +
          `${result.providerRequestId ?? sha256Hex(result.buffer)}`,
        provider: result.provider,
        model: result.model,
        providerRequestId: result.providerRequestId ?? null,
        artifactPath: referenceSheetImagePath,
        artifactSha256: sha256Hex(result.buffer),
        parentPath: character.referenceImagePath,
        parentSha256: sha256Hex(primaryReference.buffer),
        inputAncestry: {
          parents: [{
            kind: "character_reference",
            path: character.referenceImagePath,
            sha256: sha256Hex(primaryReference.buffer),
            characterId: character.id,
          }],
          referenceSource:
            character.referenceSource === "uploaded"
              ? "uploaded"
              : character.referenceSource === "generated"
                ? "generated"
                : "unknown",
          capturedAt: new Date().toISOString(),
        },
      });
      return [row];
    });
    return updated!;
  } catch (caught) {
    let err = caught;
    if (err instanceof WalletProviderSuccessPersistenceError) successfulAiWork = true;
    if (err instanceof WalletProviderPostSuccessError) {
      successfulAiWork = true;
      const operationId = err.operationId;
      await settleWalletProviderOperationDurably(operationId).catch(
        (settlementError) =>
          req.log.error(
            { err: settlementError, operationId },
            "Failed to settle character reference sheet wallet charge",
          ),
      );
      err = err.originalError;
    }
    if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
    const detail = imageErrorStatus(err);
    req.log.warn(
      {
        ...safeImageFailureLog(err),
        characterId: character.id,
        failureReason: characterVisualQaErrorMessage(err, undefined, "sheet"),
      },
      "Character reference sheet generation failed",
    );
    const [failed] = await db
      .update(charactersTable)
      .set({
        referenceSheetStatus: "failed",
        referenceSheetError:
          err instanceof CharacterInputError
            ? err.message
            : characterVisualQaErrorMessage(err, undefined, "sheet") ??
              REFERENCE_SHEET_RETRY_MESSAGE,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(charactersTable.id, character.id),
          eq(charactersTable.tenantId, req.tenantId),
        ),
      )
      .returning();
    if (!failed) throw err;
    // Preserve the saved character and expose an actionable state. Retry routes
    // use the same helper but translate this state back into an HTTP failure.
    return {
      ...failed,
      referenceSheetError:
        failed.referenceSheetError ??
        characterVisualQaErrorMessage(err, undefined, "sheet") ??
        detail.error ??
        REFERENCE_SHEET_RETRY_MESSAGE,
    };
  }
}

router.get("/characters", async (req: Request, res: Response) => {
  await ensurePresetCharacterSeeds();
  const presets = await db
    .select()
    .from(presetCharactersTable)
    .where(eq(presetCharactersTable.isActive, true))
    .orderBy(asc(presetCharactersTable.sortOrder));
  const derivatives = await listTenantPresetDerivatives(req.tenantId);
  const characters = await db
    .select()
    .from(charactersTable)
    .where(eq(charactersTable.tenantId, req.tenantId))
    .orderBy(asc(charactersTable.id));
  if (characters.length === 0) {
    res.json(presets.map((preset) => serializePreset(preset, derivatives)));
    return;
  }
  const outfits = await db
    .select()
    .from(characterOutfitsTable)
    .where(
      and(
        eq(characterOutfitsTable.tenantId, req.tenantId),
        inArray(
          characterOutfitsTable.characterId,
          characters.map((c) => c.id),
        ),
      ),
    );
  res.json(
    [
      ...presets.map((preset) => serializePreset(preset, derivatives)),
      ...characters.map((c) =>
      serializeCharacter(
        c,
        outfits.filter((o) => o.characterId === c.id),
      ),
      ),
    ],
  );
});

function serializePreset(
  preset: PresetCharacter,
  derivatives: Awaited<ReturnType<typeof listTenantPresetDerivatives>>,
) {
  return {
    id: preset.stableId,
    source: "preset" as const,
    stableId: preset.stableId,
    revision: preset.revision,
    name: preset.name,
    description: preset.description,
    referenceImagePath: preset.referenceImagePath,
    supportedLanguages: preset.supportedLanguages,
    voices: preset.voices,
    genreTags: preset.genreTags,
    usageGuidance: preset.usageGuidance,
    outfits: [
      {
        id: 0,
        name: preset.defaultOutfitName,
        description: preset.defaultOutfitDescription,
        referenceImagePath: preset.defaultOutfitReferenceImagePath,
        isDefault: true,
        status: "approved",
          identityVerified: true,
          canonicalReferenceImagePath: preset.referenceImagePath,
          protectedRegion: null,
      },
      ...derivatives
        .filter((item) => item.presetCharacterId === preset.id)
        .map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          referenceImagePath: item.referenceImagePath,
          isDefault: false,
          status: item.status,
          identityVerified: item.identityVerified,
          canonicalReferenceImagePath: item.canonicalReferenceImagePath,
          protectedRegion: item.protectedRegion,
        })),
    ],
  };
}

router.post("/preset-characters/:presetId/outfit-derivatives", async (req: Request, res: Response) => {
  const parsed = CreateCharacterOutfitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "An outfit needs a name and a description." });
    return;
  }
  const name = parsed.data.name.trim();
  const description = parsed.data.description.trim();
  const protectedRegion = parsed.data.protectedRegion;
  const resolved = await getPresetForTenant(req.tenantId, String(req.params.presetId));
  if (!resolved) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }

  let funding: Funding | null = null;
  let successfulAiWork = false;
  const startedAt = Date.now();
  try {
    funding = await reserveImageFunding(req);
    if (!funding) {
      res.status(402).json({
        error:
          "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
      });
      return;
    }
    const reservedFunding = funding;
    const baseReference = await loadReferenceImage(
      resolved.outfit.referenceImagePath,
      req.tenantId,
    );
    const exactMaskedEdit = await createOutfitMaskedEdit(
      baseReference,
      protectedRegion,
    );
    const character = {
      id: resolved.preset.id,
      tenantId: req.tenantId,
      name: resolved.preset.name,
      description: resolved.preset.description,
      referenceImagePath: resolved.preset.referenceImagePath,
      bytePlusAssetGroupId: null,
      bytePlusAssetGroupClaimedAt: null,
      atlasAssetGroupId: null,
      atlasAssetLibraryId: null,
      atlasAssetReferenceId: null,
      atlasAssetId: null,
      atlasAssetStatus: null,
      atlasAssetError: null,
      atlasAssetSyncedAt: null,
      atlasAssetClaimedAt: null,
      atlasAssetLeaseOwner: null,
      atlasAssetSubmitFencedAt: null,
      atlasAssetFenceState: null,
      atlasAssetCompensationError: null,
      atlasAssetSourcePath: null,
      atlasAssetSourceSha256: null,
      bytePlusIdentityId: null,
      referenceSource: "generated" as const,
      creationEvidence: null,
      referenceSheetImagePath: null,
      referenceSheetStatus: "approved" as const,
      referenceSheetApprovedSha256: null,
      referenceSheetError: null,
      protectedRegion,
      createdAt: resolved.preset.createdAt,
      updatedAt: resolved.preset.updatedAt,
    };
    const generated =
      funding.source === "wallet" && funding.reservation
        ? await executeWalletProviderOperation(
            {
              tenantId: req.tenantId,
              reservation: funding.reservation,
              operationKind: "character_outfit",
              operationKey: `preset-outfit:${resolved.preset.stableId}:${funding.reservation.id}`,
              settlement: {
                kind: "image",
                costPaise: null,
                refKind: "presetCharacter",
                refId: resolved.preset.stableId,
              },
            },
            (confirmSuccess) =>
              generateOutfitVariant(
                character,
                description,
                baseReference,
                {
                  tenantId: req.tenantId,
                  refKind: "presetCharacter",
                  refId: resolved.preset.stableId,
                  operationKey: characterImageOperationKey(reservedFunding, `preset-outfit:${resolved.preset.stableId}`),
                  funding: reservedFunding.meterFunding,
                },
                exactMaskedEdit,
                (meta) => confirmSuccess(meta),
              ),
            (result) => ({ provider: result.provider, model: result.model }),
            { isFailureConfirmed: isConfirmedImageFailure },
          )
        : null;
    const result =
      generated?.value ??
      (await generateOutfitVariant(
        character,
        description,
        baseReference,
        {
          tenantId: req.tenantId,
          refKind: "presetCharacter",
          refId: resolved.preset.stableId,
          operationKey: characterImageOperationKey(reservedFunding, `preset-outfit:${resolved.preset.stableId}`),
          funding: reservedFunding.meterFunding,
        },
        exactMaskedEdit,
        undefined,
      ));
    successfulAiWork = true;
    await settleImageFunding(
      req,
      funding,
      {
        durationMs: Date.now() - startedAt,
        responseBytes: result.buffer.length,
        model: result.model,
        provider: result.provider,
      },
      generated?.operationId,
    );
    const referenceImagePath = await uploadBufferToStorage(
      req.tenantId,
      result.buffer,
      "image/png",
    );
    const derivativeSha256 = sha256Hex(result.buffer);
    const presetParentSha256 = sha256Hex(baseReference.buffer);
    const [created] = await db.transaction(async (tx) => {
      const [derivative] = await tx
        .insert(presetOutfitDerivativesTable)
        .values({
          tenantId: req.tenantId,
          presetCharacterId: resolved.preset.id,
          name,
          description,
          referenceImagePath,
          status: "preview",
          identityVerified: true,
          canonicalReferenceImagePath: resolved.outfit.referenceImagePath,
          protectedRegion,
        })
        .returning();
      if (derivative) {
        await captureAssetProvenance(tx, {
          tenantId: req.tenantId,
          assetKind: "character_outfit",
          sourceKind: "imageedit",
          outfitId: derivative.id,
          operationIdentity: `preset-outfit:${resolved.preset.stableId}:${derivative.id}`,
          provider: result.provider,
          model: result.model,
          providerRequestId: result.providerRequestId ?? null,
          providerOperationId: generated?.operationId ?? null,
          artifactPath: referenceImagePath,
          artifactSha256: derivativeSha256,
          parentPath: resolved.outfit.referenceImagePath,
          parentSha256: presetParentSha256,
          inputAncestry: {
            parents: [{
              kind: "external",
              path: resolved.outfit.referenceImagePath,
              sha256: presetParentSha256,
            }],
            referenceSource: "generated",
            capturedAt: new Date().toISOString(),
          },
        });
      }
      return [derivative];
    });
    res.status(201).json(created);
  } catch (caught) {
    let err = caught;
    if (err instanceof WalletProviderSuccessPersistenceError) successfulAiWork = true;
    if (err instanceof WalletProviderPostSuccessError) {
      successfulAiWork = true;
      const operationId = err.operationId;
      await settleWalletProviderOperationDurably(operationId).catch(
        (settlementError) =>
          req.log.error(
            { err: settlementError, operationId },
            "Failed to settle character image wallet charge",
          ),
      );
      err = err.originalError;
    }
    if (err instanceof ImagePreservationError && err.providerWorkCompleted) {
      successfulAiWork = true;
    }
    if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
    const { status, error } = imageErrorStatus(err);
    res.status(status).json({ error });
  }
});

router.patch(
  "/preset-characters/:presetId/outfit-derivatives/:derivativeId",
  async (req: Request, res: Response) => {
    const derivativeId = Number(req.params.derivativeId);
    const parsed = UpdatePresetOutfitDerivativeBody.safeParse(req.body);
    if (!Number.isInteger(derivativeId) || !parsed.success) {
      res.status(400).json({ error: "Invalid derivative update." });
      return;
    }
    const { status, name } = parsed.data;
    const preset = await getPresetForTenant(req.tenantId, String(req.params.presetId));
    if (!preset) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [existing] = await db
      .select()
      .from(presetOutfitDerivativesTable)
      .where(
        and(
          eq(presetOutfitDerivativesTable.id, derivativeId),
          eq(presetOutfitDerivativesTable.tenantId, req.tenantId),
          eq(presetOutfitDerivativesTable.presetCharacterId, preset.preset.id),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (status === "approved" && !existing.identityVerified) {
      res.status(400).json({ error: "This outfit did not pass identity preservation." });
      return;
    }
    if (existing.status === "rejected" && status === "approved") {
      res.status(400).json({ error: "A rejected preview cannot be approved." });
      return;
    }
    const [updated] = await db
      .update(presetOutfitDerivativesTable)
      .set({
        ...(status ? { status } : {}),
        ...(typeof name === "string" ? { name: name.trim() } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(presetOutfitDerivativesTable.id, derivativeId),
          eq(presetOutfitDerivativesTable.tenantId, req.tenantId),
          eq(presetOutfitDerivativesTable.presetCharacterId, preset.preset.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(updated);
  },
);

router.get("/admin/preset-characters", requireSuperadmin, async (_req, res) => {
  await ensurePresetCharacterSeeds();
  res.json(await db.select().from(presetCharactersTable).orderBy(asc(presetCharactersTable.sortOrder)));
});

router.put("/admin/preset-characters/order", requireSuperadmin, async (req, res) => {
  const stableIds = req.body?.stableIds;
  if (
    !Array.isArray(stableIds) ||
    stableIds.length === 0 ||
    stableIds.some((id) => typeof id !== "string") ||
    new Set(stableIds).size !== stableIds.length
  ) {
    res.status(400).json({ error: "Provide each preset id exactly once." });
    return;
  }
  const all = await db.select({ stableId: presetCharactersTable.stableId }).from(presetCharactersTable);
  if (
    all.length !== stableIds.length ||
    all.some((row) => !stableIds.includes(row.stableId))
  ) {
    res.status(400).json({ error: "Provide each preset id exactly once." });
    return;
  }
  await db.transaction(async (tx) => {
    // Move out of the positive namespace first so the unique order index also
    // permits swaps.
    await tx.update(presetCharactersTable).set({
      sortOrder: sql`-${presetCharactersTable.sortOrder}`,
      revision: sql`${presetCharactersTable.revision} + 1`,
      updatedAt: new Date(),
    });
    for (const [index, stableId] of stableIds.entries()) {
      await tx
        .update(presetCharactersTable)
        .set({ sortOrder: index + 1 })
        .where(eq(presetCharactersTable.stableId, stableId));
    }
  });
  res.json(await db.select().from(presetCharactersTable).orderBy(asc(presetCharactersTable.sortOrder)));
});

router.patch("/admin/preset-characters/:presetId", requireSuperadmin, async (req, res) => {
  const stableId = String(req.params.presetId);
  const input = presetAdminInput(req.body, true, stableId);
  if (!input) {
    res.status(400).json({ error: "Invalid preset update." });
    return;
  }
  if (input.sortOrder !== undefined) {
    const [conflict] = await db
      .select({ stableId: presetCharactersTable.stableId })
      .from(presetCharactersTable)
      .where(eq(presetCharactersTable.sortOrder, input.sortOrder as number))
      .limit(1);
    if (conflict && conflict.stableId !== stableId) {
      res.status(409).json({ error: "That sort order is already in use; use the reorder endpoint." });
      return;
    }
  }
  const [updated] = await db
    .update(presetCharactersTable)
    .set({ ...input, revision: sql`${presetCharactersTable.revision} + 1`, updatedAt: new Date() })
    .where(eq(presetCharactersTable.stableId, stableId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(updated);
});

function presetAdminInput(value: unknown, partial: boolean, stableId?: string) {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "name", "description", "referenceImagePath", "supportedLanguages", "voices",
    "defaultOutfitName", "defaultOutfitDescription", "defaultOutfitReferenceImagePath",
    "genreTags", "usageGuidance", "isActive", "sortOrder",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (partial && Object.keys(body).length === 0) return null;
  const requiredStrings = [
    "stableId",
    "name",
    "description",
    "referenceImagePath",
    "defaultOutfitName",
    "defaultOutfitDescription",
    "defaultOutfitReferenceImagePath",
    "usageGuidance",
  ] as const;
  const result: Record<string, unknown> = {};
  for (const key of requiredStrings) {
    if (key === "stableId" && partial) continue;
    if (body[key] === undefined && partial) continue;
    if (typeof body[key] !== "string" || !body[key].trim()) return null;
    result[key] = body[key].trim();
  }
  for (const key of ["supportedLanguages", "voices", "genreTags"] as const) {
    if (body[key] === undefined && partial) continue;
    if (!Array.isArray(body[key]) || body[key].length === 0) return null;
    result[key] = body[key];
  }
  for (const pathKey of [
    "referenceImagePath",
    "defaultOutfitReferenceImagePath",
  ] as const) {
    if (
      result[pathKey] !== undefined &&
      (typeof result[pathKey] !== "string" ||
        !result[pathKey].startsWith(`/preset-assets/${stableId ?? ""}/`) ||
        !(
          result[pathKey] === `/preset-assets/${stableId ?? ""}/identity.svg` ||
          result[pathKey] === `/preset-assets/${stableId ?? ""}/signature.svg`
        ))
    ) {
      return null;
    }
  }
  if (
    result.supportedLanguages !== undefined &&
    (!(result.supportedLanguages as unknown[]).every(
      (language) => typeof language === "string" && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language),
    ) ||
      new Set(result.supportedLanguages as string[]).size !==
        (result.supportedLanguages as string[]).length ||
      (result.supportedLanguages as string[]).length > 12)
  ) {
    return null;
  }
  if (
    result.genreTags !== undefined &&
    (!(result.genreTags as unknown[]).every(
      (tag) => typeof tag === "string" && Boolean(tag.trim()),
    ) ||
      new Set(result.genreTags as string[]).size !== (result.genreTags as string[]).length ||
      (result.genreTags as string[]).length > 12)
  ) {
    return null;
  }
  if (
    result.voices !== undefined &&
    (!(result.voices as unknown[]).every((voice) => {
      if (!voice || typeof voice !== "object") return false;
      const candidate = voice as Record<string, unknown>;
      return (
        typeof candidate.id === "string" &&
        candidate.provider === "openai" &&
        candidate.model === "gpt-audio" &&
        ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(
          String(candidate.speaker),
        ) &&
        typeof candidate.label === "string" &&
        typeof candidate.license === "string" &&
        Array.isArray(candidate.languages) &&
        candidate.languages.every((language) => typeof language === "string")
      );
    }) ||
      new Set((result.voices as Array<{ id: string }>).map((voice) => voice.id)).size !==
        (result.voices as unknown[]).length ||
      (result.voices as unknown[]).length > 4)
  ) {
    return null;
  }
  const languages = result.supportedLanguages as string[] | undefined;
  const voices = result.voices as Array<{ languages: string[] }> | undefined;
  if (languages && voices && voices.some((voice) => voice.languages.some((language) => !languages.includes(language)))) return null;
  if (body.sortOrder !== undefined || !partial) {
    if (!Number.isInteger(body.sortOrder) || Number(body.sortOrder) < 1) return null;
    result.sortOrder = body.sortOrder;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return null;
    result.isActive = body.isActive;
  }
  return result as typeof presetCharactersTable.$inferInsert;
}

router.post("/characters", async (req: Request, res: Response) => {
  const parsed = CreateCharacterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const name = parsed.data.name.trim();
  const description = parsed.data.description?.trim() ?? "";
  const sourceImagePath = parsed.data.sourceImagePath ?? null;
  const identityId = parsed.data.identityId ?? null;
  if (!name) {
    res.status(400).json({ error: "A character name is required." });
    return;
  }
  if (!sourceImagePath && !description) {
    res.status(400).json({
      error: "Describe the character, or upload a reference photo.",
    });
    return;
  }
  if (sourceImagePath && !sourceImagePath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid reference image path." });
    return;
  }
  if (identityId !== null) {
    const identity = await getBytePlusIdentity(req.tenantId, identityId);
    if (!sourceImagePath || identity?.status !== "verified" || !identity.assetGroupId) {
      res.status(400).json({
        error: "A verified BytePlus identity and its uploaded reference photo are required.",
      });
      return;
    }
  }

  /**
   * An uploaded likeness attests at creation, in the same transaction as the
   * character row.
   *
   * Previously the attestation was a separate call the user had to find in a
   * panel afterwards, so a character could be created, sheeted and dressed —
   * spending image credits at each step — and only fail at video funding. The
   * gate belongs at the moment the photograph arrives.
   */
  const attestation = parsed.data.likenessAttestation ?? null;
  const attestationSubjectClass: LikenessSubjectClass | null = sourceImagePath
    ? (attestation?.subject === "authorized_person"
        ? "uploaded_authorized_person"
        : "uploaded_self")
    : null;
  if (sourceImagePath) {
    if (!attestation) {
      res.status(400).json({
        error:
          "A likeness-rights attestation is required to create a character from an uploaded photo.",
      });
      return;
    }
    // policyVersion is optional here. The creation form shows a summary rather
    // than the server statement verbatim, so asserting "I saw exactly v X"
    // would add a round trip without adding the protection it implies. When a
    // client does send one it still has to match. Either way the stored grant
    // carries the server's own version and the authoritative statement text.
    if (
      attestation.policyVersion != null &&
      attestation.policyVersion !== likenessPolicyVersion()
    ) {
      res.status(409).json({
        error: "The consent policy changed. Reload and review it again.",
      });
      return;
    }
    const attestationError = validateLikenessGrantAttestation(attestation);
    if (attestationError) {
      res.status(400).json({ error: attestationError });
      return;
    }
  } else if (attestation) {
    res.status(400).json({
      error:
        "A generated character has no real subject to attest for; the workspace declaration covers it.",
    });
    return;
  }

  const existing = await db
    .select({ id: charactersTable.id })
    .from(charactersTable)
    .where(eq(charactersTable.tenantId, req.tenantId));
  if (existing.length >= MAX_CHARACTERS) {
    res.status(400).json({
      error: `You can save up to ${MAX_CHARACTERS} characters. Delete one to add another.`,
    });
    return;
  }

  let referenceImagePath: string;
  let referenceSha256: string;
  let referenceProvider: string | null = null;
  let referenceModel: string | null = null;
  let referenceProviderRequestId: string | null = null;
  let referenceProviderOperationId: number | null = null;
  let funding: Funding | null = null;
  let successfulAiWork = false;
  const startedAt = Date.now();
  try {
    if (sourceImagePath) {
      // Uploaded photo: validate it exists, is an image, and fits; no AI cost.
      const uploadedReference = await loadReferenceImage(sourceImagePath, req.tenantId);
      referenceSha256 = sha256Hex(uploadedReference.buffer);
      referenceImagePath = sourceImagePath;
    } else {
      // Generated reference: funds like any image generation.
      funding = await reserveImageFunding(req);
      if (!funding) {
        res.status(402).json({
          error:
            "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
        });
        return;
      }
      const reservedFunding = funding;
      const generated =
        funding.source === "wallet" && funding.reservation
          ? await executeWalletProviderOperation(
              {
                tenantId: req.tenantId,
                reservation: funding.reservation,
                operationKind: "character_reference",
                operationKey: characterImageOperationKey(reservedFunding, `character-reference:${req.tenantId}:${name}`),
                settlement: {
                  kind: "image",
                  costPaise: null,
                  refKind: "character",
                  refId: name,
                },
              },
              () => generateCharacterReference(description, {
                tenantId: req.tenantId,
                refKind: "character",
                refId: name,
                operationKey: characterImageOperationKey(reservedFunding, `character-reference:${req.tenantId}:${name}`),
                funding: reservedFunding.meterFunding,
              }),
              (result) => ({ provider: result.provider, model: result.model }),
              { isFailureConfirmed: isConfirmedImageFailure },
            )
          : null;
      const result = generated?.value ?? (await generateCharacterReference(description, {
        tenantId: req.tenantId,
        refKind: "character",
        refId: name,
        operationKey: characterImageOperationKey(reservedFunding, `character-reference:${req.tenantId}:${name}`),
        funding: reservedFunding.meterFunding,
      }));
      referenceProvider = result.provider;
      referenceModel = result.model;
      referenceProviderRequestId = result.providerRequestId ?? null;
      referenceProviderOperationId = generated?.operationId ?? null;
      // The paid provider result is complete before local object persistence.
      // A later upload failure must not relabel successful provider work as a
      // failure or refund its reservation.
      successfulAiWork = true;
      await settleImageFunding(req, funding, {
        durationMs: Date.now() - startedAt,
        responseBytes: result.buffer.length,
        model: result.model,
        provider: result.provider,
      }, generated?.operationId);
      referenceImagePath = await uploadBufferToStorage(
        req.tenantId,
        result.buffer,
        "image/png",
      );
      referenceSha256 = sha256Hex(result.buffer);
    }
  } catch (err) {
    if (err instanceof WalletProviderSuccessPersistenceError) successfulAiWork = true;
    if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
    const { status, error } = imageErrorStatus(err);
    res.status(status).json({ error });
    return;
  }

  const defaultOutfitApprovalSha256 = referenceSha256;

  // Re-check the cap atomically: lock the tenant row so parallel creates
  // serialize and cannot slip past the count check together.
  const created = await db.transaction(async (tx) => {
    await tx
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .for("update");
    const count = await tx
      .select({ id: charactersTable.id })
      .from(charactersTable)
      .where(eq(charactersTable.tenantId, req.tenantId));
    if (count.length >= MAX_CHARACTERS) return null;
    const character = (
      await tx
        .insert(charactersTable)
        .values({
          tenantId: req.tenantId,
          name,
          description,
          referenceImagePath,
          referenceSource: sourceImagePath ? "uploaded" : "generated",
          bytePlusIdentityId: identityId,
        })
        .returning()
    )[0]!;
    // Same transaction: no uploaded likeness row can exist without its grant.
    if (sourceImagePath && attestation && attestationSubjectClass) {
      const [grant] = await tx
        .insert(characterLikenessConsentGrantsTable)
        .values({
          tenantId: req.tenantId,
          characterId: character.id,
          sourcePath: referenceImagePath,
          sourceSha256: referenceSha256,
          sourceReferenceSource: "uploaded",
          subjectClass: attestationSubjectClass,
          policyVersion: likenessPolicyVersion(),
          statement: likenessConsentStatement(attestationSubjectClass),
          subject: attestation.subject,
          imageRightsConfirmed: attestation.imageRightsConfirmed,
          adultConfirmed: attestation.adultConfirmed,
          likenessConfirmed: attestation.likenessConfirmed,
          writtenPermissionConfirmed: attestation.writtenPermissionConfirmed,
          allowOutfitEdits: attestation.allowOutfitEdits,
          allowVideoDepiction: attestation.allowVideoDepiction,
          allowScriptedSpeech: attestation.allowScriptedSpeech,
          actingClerkUserId: req.clerkUserId,
        })
        .returning();
      // Disclose the recipients the reference sheet is about to use, so the
      // very next step in this flow is not blocked on a second click.
      if (grant) {
        const plan = await disclosedPersonalImageProcessorPlan();
        for (const operation of ["reference_sheet", "outfit"] as const) {
          const recipient = plan?.[operation];
          if (!recipient) continue;
          if (
            !resolveLikenessRouting({
              surface: "image",
              provider: recipient.provider,
              model: recipient.model,
              operation,
              subjectClass: attestationSubjectClass,
            }).allowed
          ) {
            continue;
          }
          await tx
            .insert(characterLikenessRecipientDisclosuresTable)
            .values({
              tenantId: req.tenantId,
              characterId: character.id,
              consentId: grant.id,
              provider: recipient.provider,
              model: recipient.model,
              operation,
              scopeLabel: recipient.scopeLabel,
              actingClerkUserId: req.clerkUserId,
            })
            .onConflictDoNothing();
        }
      }
    }
    const defaultOutfit = (
      await tx
        .insert(characterOutfitsTable)
        .values({
          tenantId: req.tenantId,
          characterId: character.id,
          name: "Default",
          description: description || "as shown in the reference image",
          referenceImagePath,
          isDefault: true,
          atlasApprovedSourceSha256: defaultOutfitApprovalSha256,
        })
        .returning()
    )[0]!;
    const portraitProvenance = await captureAssetProvenance(tx, {
      tenantId: req.tenantId,
      assetKind: "character_reference",
      sourceKind: sourceImagePath ? "upload" : "textgenerated",
      characterId: character.id,
      operationIdentity: `character-library:${character.id}:reference`,
      provider: referenceProvider,
      model: referenceModel,
      providerRequestId: referenceProviderRequestId,
      artifactPath: referenceImagePath,
      artifactSha256: referenceSha256,
      inputAncestry: {
        parents: [],
        referenceSource: sourceImagePath ? "uploaded" : "generated",
        capturedAt: new Date().toISOString(),
      },
    });
    if (!sourceImagePath) {
      await tx
        .update(charactersTable)
        .set({
          creationEvidence: {
            version: 1,
            kind: "character_library",
            method: "textgenerated",
            draftId: 0,
            draftRevision: 0,
            roleId: "character-library",
            operationKey: `character-reference:${req.tenantId}:${name}`,
            provider: referenceProvider!,
            model: referenceModel!,
            providerOperationId: referenceProviderOperationId,
            sourcePath: referenceImagePath,
            sourceSha256: referenceSha256,
            provenanceRecordId: portraitProvenance!.id,
            recordedAt: new Date().toISOString(),
          },
        })
        .where(eq(charactersTable.id, character.id));
    }
    await captureAssetProvenance(tx, {
      tenantId: req.tenantId,
      assetKind: "character_outfit",
      sourceKind: sourceImagePath ? "upload" : "derived",
      characterId: character.id,
      outfitId: defaultOutfit.id,
      operationIdentity: `character-library:${character.id}:default-outfit`,
      provider: null,
      model: null,
      artifactPath: referenceImagePath,
      artifactSha256: referenceSha256,
      parentPath: referenceImagePath,
      parentSha256: referenceSha256,
      inputAncestry: {
        parents: [{
          kind: "character_reference",
          path: referenceImagePath,
          sha256: referenceSha256,
          characterId: character.id,
        }],
        referenceSource: sourceImagePath ? "uploaded" : "generated",
        capturedAt: new Date().toISOString(),
      },
    });
    return { character, defaultOutfit };
  });
  if (!created) {
    if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
    res.status(400).json({
      error: `You can save up to ${MAX_CHARACTERS} characters. Delete one to add another.`,
    });
    return;
  }
  const characterWithSheet = await generateAndPersistReferenceSheet(
    req,
    created.character,
  );
  registerOutfitAssetInBackground({
    tenantId: req.tenantId,
    character: characterWithSheet,
    outfit: created.defaultOutfit,
  });
  res
    .status(201)
    .json(serializeCharacter(characterWithSheet, [created.defaultOutfit]));
});

router.param("characterId", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

async function loadCharacter(req: Request): Promise<Character | undefined> {
  return (
    await db
      .select()
      .from(charactersTable)
      .where(
        and(
          eq(charactersTable.id, Number(req.params.characterId)),
          eq(charactersTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
}

interface PersonalImageProcessorRecipient {
  scopeLabel: string;
  provider: string;
  model: string;
  selectionPolicy: {
    provider: string;
    model: string | null;
    customBaseUrl: string | null;
    fallbackEnabled: false;
  };
}

interface PersonalImageProcessorPlan {
  scope: string[];
  reference_sheet: PersonalImageProcessorRecipient;
  outfit: PersonalImageProcessorRecipient;
}

function personalProcessorLabel(provider: string, model: string): string | null {
  const def = getImageGenProviderDef(provider);
  if (!def || provider === "custom" || provider.startsWith("custom:")) return null;
  // Only catalogued built-ins and their explicit shipped model choices are
  // trusted recipients. Free-text/custom/Auto routing fails closed.
  const vettedModels = new Set([
    def.defaultModel,
    ...(def.modelOptions?.map((option) => option.value) ?? []),
    // Existing workspaces can pin maintained Nano Banana models through the
    // Replicate adapter; their exact paths remain part of consent scope.
    "google/nano-banana",
    "google/nano-banana-pro",
  ]);
  if (!vettedModels.has(model)) return null;
  return `${def.label} / ${model}`;
}

function recipientFor(
  purpose: "reference_sheet" | "outfit",
  provider: string,
  model: string,
  modelOverride: string | null,
): PersonalImageProcessorRecipient | null {
  const label = personalProcessorLabel(provider, model);
  if (!label) return null;
  return {
    scopeLabel: `${purpose}|${label}`,
    provider,
    model,
    selectionPolicy: {
      provider,
      model: modelOverride,
      customBaseUrl: null,
      fallbackEnabled: false,
    },
  };
}

/**
 * A consent describes a closed purpose plan, not a mutable global route.
 * Sheet work may retain a currently selected trusted reference-capable
 * recipient; protected wardrobe work is explicitly disclosed as OpenAI's
 * exact-mask processor. An incapable/unknown sheet selection is likewise
 * replaced *in the disclosure* by OpenAI, never at runtime as a fallback.
 */
async function disclosedPersonalImageProcessorPlan(): Promise<PersonalImageProcessorPlan | null> {
  const selection = await getImageGenSelection();
  const openAi = getImageGenProviderDef("openai");
  if (!openAi) return null;
  const openAiRecipient = recipientFor(
    "outfit",
    "openai",
    openAi.defaultModel,
    null,
  );
  const openAiSheetRecipient = recipientFor(
    "reference_sheet",
    "openai",
    openAi.defaultModel,
    null,
  );
  if (!openAiRecipient || !openAiSheetRecipient) return null;
  // Global Auto/custom/unknown settings are not recipients. They produce an
  // explicit OpenAI sheet plan visible before consent rather than a covert
  // routing decision after consent.
  if (selection.provider === IMAGE_GEN_AUTO || selection.customBaseUrl !== null) {
    return {
      scope: [openAiSheetRecipient.scopeLabel, openAiRecipient.scopeLabel],
      reference_sheet: openAiSheetRecipient,
      outfit: openAiRecipient,
    };
  }
  const def = getImageGenProviderDef(selection.provider);
  if (!def) {
    return {
      scope: [openAiSheetRecipient.scopeLabel, openAiRecipient.scopeLabel],
      reference_sheet: openAiSheetRecipient,
      outfit: openAiRecipient,
    };
  }
  const model = effectiveModel(def, selection.model);
  const selectedSheet = recipientFor(
    "reference_sheet",
    selection.provider,
    model,
    selection.model,
  );
  const referenceSheet = selectedSheet && supportsReferenceInput(def, model)
    ? selectedSheet
    : openAiSheetRecipient;
  return {
    scope: [referenceSheet.scopeLabel, openAiRecipient.scopeLabel],
    reference_sheet: referenceSheet,
    outfit: openAiRecipient,
  };
}

async function personalImageDispatchGate(
  character: Character,
  sourceSha256: string,
  operation: "reference_sheet" | "outfit",
) {
  const plan = await disclosedPersonalImageProcessorPlan();
  const policyVersion = likenessPolicyVersion();
  const recipient = plan?.[operation];
  const provider = recipient && getImageGenProviderDef(recipient.provider);
  if (!plan || !recipient || !provider) {
    throw new PersonalLikenessConsentError(
      "Personal image processing requires a configured trusted built-in image provider and exact catalog model; Auto, custom endpoints, and unknown models are not eligible.",
    );
  }
  if (
    !supportsReferenceInput(provider, recipient.model) ||
    (operation === "outfit" && !provider.supportsExactMaskedEdits)
  ) {
    const requirement = operation === "outfit"
      ? "reference input plus exact protected-region masked edits"
      : "approved reference-image input";
    throw new PersonalLikenessConsentError(
      `The consented processor ${recipient.scopeLabel} cannot perform ${requirement}. No fallback provider will be called.`,
    );
  }
  const frozen = await freezePersonalImageConsent({
    tenantId: character.tenantId,
    character,
    sourceSha256,
    policyVersion,
    provider: recipient.provider,
    model: recipient.model,
    operation,
  });
  return {
    pinnedRecipient: frozen
      ? { provider: recipient.provider, model: recipient.model }
      : undefined,
    selectionPolicy: frozen
      ? recipient.selectionPolicy
      : undefined,
    // Re-checked against whatever recipient the pipeline actually reaches, not
    // against the one planned here, so a mid-flight substitution is caught.
    beforeProviderDispatch: frozen
      ? (dispatched: { provider: string; model: string }) =>
          assertFrozenPersonalImageConsent({
            tenantId: character.tenantId,
            characterId: character.id,
            frozen,
            sourceSha256,
            provider: dispatched.provider,
            model: dispatched.model,
            operation,
          })
      : undefined,
  };
}

/**
 * The attestation's version is the policy text's version, full stop.
 *
 * It deliberately no longer mixes in a hash of the selected image processors.
 * Doing so meant an admin changing the global image provider marked every
 * attestation in the system stale, because a statement about who is in a
 * photograph was being versioned by routing that does not change who is in the
 * photograph. Recipients are disclosed and acknowledged per provider instead.
 */
function likenessPolicyVersion(): string {
  return LIKENESS_CONSENT_POLICY_VERSION;
}

async function currentSourceSha256(
  character: Character,
  tenantId: number,
): Promise<string | null> {
  try {
    return sha256Hex(
      (await loadReferenceImage(character.referenceImagePath, tenantId)).buffer,
    );
  } catch {
    return null;
  }
}

async function likenessConsentDescriptor(character: Character, tenantId: number) {
  const [sourceSha256, imageProcessorPlan] = await Promise.all([
    currentSourceSha256(character, tenantId),
    disclosedPersonalImageProcessorPlan(),
  ]);
  const policyVersion = likenessPolicyVersion();
  const subjectClass = routingSubjectClassFor(character);
  const statement = likenessConsentStatement(subjectClass);
  const personal = isPersonalLikenessSource(character);
  const grant = await latestGrant(tenantId, character.id);
  const [revocation] = grant
    ? await db
      .select()
      .from(characterLikenessConsentRevocationsTable)
      .where(
        and(
          eq(characterLikenessConsentRevocationsTable.tenantId, tenantId),
          eq(characterLikenessConsentRevocationsTable.characterId, character.id),
          eq(characterLikenessConsentRevocationsTable.consentId, grant.id),
        ),
      )
      .limit(1)
    : [];

  // Recipients disclosed under this grant, with any per-recipient withdrawal.
  const recipientRows = grant
    ? await db
      .select({
        disclosure: characterLikenessRecipientDisclosuresTable,
        revokedAt: characterLikenessRecipientRevocationsTable.revokedAt,
      })
      .from(characterLikenessRecipientDisclosuresTable)
      .leftJoin(
        characterLikenessRecipientRevocationsTable,
        eq(
          characterLikenessRecipientRevocationsTable.disclosureId,
          characterLikenessRecipientDisclosuresTable.id,
        ),
      )
      .where(
        and(
          eq(characterLikenessRecipientDisclosuresTable.tenantId, tenantId),
          eq(characterLikenessRecipientDisclosuresTable.consentId, grant.id),
        ),
      )
      .orderBy(desc(characterLikenessRecipientDisclosuresTable.acknowledgedAt))
    : [];
  const recipients = recipientRows.map((row) => ({
    id: row.disclosure.id,
    provider: row.disclosure.provider,
    model: row.disclosure.model,
    operation: row.disclosure.operation,
    scopeLabel: row.disclosure.scopeLabel,
    acknowledgedAt: row.disclosure.acknowledgedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
  const acknowledged = new Set(
    recipientRows
      .filter((row) => !row.revokedAt)
      .map((row) =>
        `${row.disclosure.operation}|${row.disclosure.provider}|${row.disclosure.model}`
      ),
  );

  // Recipients the CURRENT routing needs but that have not been acknowledged.
  // This is a one-click gap, never a reason to re-sign the attestation.
  const pendingRecipients = (
    ["reference_sheet", "outfit"] as const
  ).flatMap((operation) => {
    const recipient = imageProcessorPlan?.[operation];
    if (!recipient) return [];
    const key = `${operation}|${recipient.provider}|${recipient.model}`;
    if (acknowledged.has(key)) return [];
    const routing = resolveLikenessRouting({
      surface: "image",
      provider: recipient.provider,
      model: recipient.model,
      operation,
      subjectClass,
    });
    return [{
      operation,
      provider: recipient.provider,
      model: recipient.model,
      scopeLabel: recipient.scopeLabel,
      providerAccepts: routing.allowed,
      reason: routing.allowed ? null : routing.reason,
    }];
  });

  const currentGrant =
    grant &&
    grant.sourcePath === character.referenceImagePath &&
    grant.sourceSha256 === sourceSha256 &&
    grant.policyVersion === policyVersion;
  const status = !personal
    ? "not_required"
    : !grant
      ? "missing"
      : !currentGrant
        ? "stale"
        : revocation
          ? "revoked"
          : pendingRecipients.some((entry) => entry.providerAccepts)
            ? "needs_recipient_acknowledgement"
            : "active";

  /**
   * Universal eligibility: every catalogued provider, with a reviewed verdict
   * for THIS character's subject class. The old shape hard-coded two Atlas Wan
   * rows, which answered the question for one provider and left the rest of the
   * catalog silent.
   */
  const eligibility = PROVIDER_LIKENESS_DECLARATIONS.map((declaration) => {
    const routing = resolveLikenessRouting({
      surface: declaration.surface,
      provider: declaration.providerId,
      model: declaration.realLikenessModelAllowlist?.[0] ?? null,
      operation: declaration.surface === "video" ? "video" : "outfit",
      subjectClass,
    });
    const attestationSatisfied = !personal || status === "active";
    return {
      surface: declaration.surface,
      provider: declaration.providerId,
      modelFamily: declaration.realLikenessModelAllowlist?.join(", ") ?? "all catalogued models",
      requiresVerifiedIdentity: declaration.requiresVerifiedIdentity,
      status: !routing.allowed
        ? "provider_refused"
        : attestationSatisfied
          ? "eligible"
          : sourceSha256
            ? "consent_required"
            : "verification_required",
      reason: !routing.allowed
        ? routing.reason
        : attestationSatisfied
          ? "A current attestation and an acknowledged recipient permit this provider."
          : sourceSha256
            ? "A current unrevoked attestation covering the requested uses is required."
            : "The current tenant-owned source bytes could not be verified.",
    };
  });

  return {
    status,
    sourceSha256,
    policyVersion,
    statement,
    subjectClass,
    consent: grant
      ? {
          id: grant.id,
          subject: grant.subject,
          subjectClass: grant.subjectClass,
          allowOutfitEdits: grant.allowOutfitEdits,
          allowVideoDepiction: grant.allowVideoDepiction,
          allowScriptedSpeech: grant.allowScriptedSpeech,
          grantedAt: grant.grantedAt.toISOString(),
          revokedAt: revocation?.revokedAt.toISOString() ?? null,
        }
      : null,
    recipients,
    pendingRecipients,
    eligibility,
  };
}


router.get("/characters/:characterId/likeness-consent", async (req: Request, res: Response) => {
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ data: await likenessConsentDescriptor(character, req.tenantId) });
});

router.post("/characters/:characterId/likeness-consent", async (req: Request, res: Response) => {
  if (!hasOnlyLikenessConsentRequestKeys(req.body, "grant")) {
    res.status(400).json({ error: "Invalid likeness consent attestation." });
    return;
  }
  const parsed = GrantCharacterLikenessConsentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid likeness consent attestation." });
    return;
  }
  const requested = parsed.data;
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!isPersonalLikenessSource(character)) {
    res.status(409).json({
      error: "Only an uploaded personal source can receive a likeness attestation; generated and unknown sources are never relabeled.",
    });
    return;
  }
  const attestationError = validateLikenessGrantAttestation(requested);
  if (attestationError) {
    res.status(400).json({ error: attestationError });
    return;
  }
  const imageProcessorPlan = await disclosedPersonalImageProcessorPlan();
  if (requested.allowOutfitEdits && !imageProcessorPlan) {
    res.status(409).json({
      error: "Personal outfit editing requires the current trusted built-in image provider and an exact catalog model; Auto, custom endpoints, and unknown models cannot be consented.",
    });
    return;
  }
  const policyVersion = likenessPolicyVersion();
  if (requested.policyVersion !== policyVersion) {
    res.status(409).json({ error: "The consent policy changed. Reload and review it again." });
    return;
  }
  const subjectClass: LikenessSubjectClass = requested.subject === "authorized_person"
    ? "uploaded_authorized_person"
    : "uploaded_self";
  const granted = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(charactersTable)
      .where(and(
        eq(charactersTable.id, character.id),
        eq(charactersTable.tenantId, req.tenantId),
      ))
      .for("update")
      .limit(1);
    if (!locked || !isPersonalLikenessSource(locked)) return null;
    const sourceSha256 = await currentSourceSha256(locked, req.tenantId);
    if (!sourceSha256 || sourceSha256 !== requested.sourceSha256.toLowerCase()) {
      return null;
    }
    const [row] = await tx
      .insert(characterLikenessConsentGrantsTable)
      .values({
        tenantId: req.tenantId,
        characterId: locked.id,
        sourcePath: locked.referenceImagePath,
        sourceSha256,
        sourceReferenceSource: "uploaded",
        subjectClass,
        policyVersion,
        statement: likenessConsentStatement(subjectClass),
        subject: requested.subject,
        imageRightsConfirmed: requested.imageRightsConfirmed,
        adultConfirmed: requested.adultConfirmed,
        likenessConfirmed: requested.likenessConfirmed,
        writtenPermissionConfirmed: requested.writtenPermissionConfirmed,
        allowOutfitEdits: requested.allowOutfitEdits,
        allowVideoDepiction: requested.allowVideoDepiction ?? false,
        allowScriptedSpeech: requested.allowScriptedSpeech,
        actingClerkUserId: req.clerkUserId,
      })
      .returning();
    if (!row) return null;
    // Disclose the recipients the current routing will actually use, in the
    // same transaction, so the common case needs no second click. Only
    // recipients the reviewed policy accepts are written; a refused one is
    // surfaced by the descriptor instead of being silently authorized.
    for (const operation of ["reference_sheet", "outfit"] as const) {
      const recipient = imageProcessorPlan?.[operation];
      if (!recipient) continue;
      const routing = resolveLikenessRouting({
        surface: "image",
        provider: recipient.provider,
        model: recipient.model,
        operation,
        subjectClass,
      });
      if (!routing.allowed) continue;
      await tx
        .insert(characterLikenessRecipientDisclosuresTable)
        .values({
          tenantId: req.tenantId,
          characterId: locked.id,
          consentId: row.id,
          provider: recipient.provider,
          model: recipient.model,
          operation,
          scopeLabel: recipient.scopeLabel,
          actingClerkUserId: req.clerkUserId,
        })
        .onConflictDoNothing();
    }
    return row;
  });
  if (!granted) {
    res.status(409).json({ error: "The current tenant-owned source changed or could not be verified. Reload before attesting." });
    return;
  }
  const current = await loadCharacter(req);
  res.status(201).json({ data: await likenessConsentDescriptor(current!, req.tenantId) });
});

router.delete("/characters/:characterId/likeness-consent", async (req: Request, res: Response) => {
  if (!hasOnlyLikenessConsentRequestKeys(req.body ?? {}, "revoke")) {
    res.status(400).json({ error: "Invalid likeness consent revocation." });
    return;
  }
  const parsed = RevokeCharacterLikenessConsentBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid likeness consent revocation." });
    return;
  }
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const conflict = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(charactersTable)
      .where(and(eq(charactersTable.id, character.id), eq(charactersTable.tenantId, req.tenantId)))
      .for("update")
      .limit(1);
    if (!locked) return true;
    const [grant] = await tx
      .select()
      .from(characterLikenessConsentGrantsTable)
      .where(and(
        eq(characterLikenessConsentGrantsTable.tenantId, req.tenantId),
        eq(characterLikenessConsentGrantsTable.characterId, locked.id),
      ))
      .orderBy(desc(characterLikenessConsentGrantsTable.grantedAt), desc(characterLikenessConsentGrantsTable.id))
      .limit(1);
    if (!grant) return false;
    if (parsed.data.consentId !== undefined && parsed.data.consentId !== grant.id) return true;
    await tx
      .insert(characterLikenessConsentRevocationsTable)
      .values({
        tenantId: req.tenantId,
        characterId: locked.id,
        consentId: grant.id,
        actingClerkUserId: req.clerkUserId,
      })
      .onConflictDoNothing();
    return false;
  });
  if (conflict) {
    res.status(409).json({ error: "The requested consent is no longer current. Reload before revoking." });
    return;
  }
  const current = await loadCharacter(req);
  res.json({ data: await likenessConsentDescriptor(current!, req.tenantId) });
});

/**
 * Acknowledge one recipient under the current attestation.
 *
 * This is the cheap half of the two-layer design: the attestation covers the
 * person and does not change when the routing does, so a newly configured
 * provider costs one acknowledgement instead of a re-signature. Only a
 * recipient the reviewed provider policy accepts can be acknowledged — a user
 * cannot consent their way past a provider that will refuse the image.
 */
router.post("/characters/:characterId/likeness-recipients", async (req: Request, res: Response) => {
  if (!hasOnlyLikenessConsentRequestKeys(req.body ?? {}, "recipient")) {
    res.status(400).json({ error: "Invalid recipient acknowledgement." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const provider = typeof body.provider === "string" ? body.provider : null;
  const model = typeof body.model === "string" ? body.model : null;
  const operation = typeof body.operation === "string" ? body.operation : null;
  const consentId = typeof body.consentId === "number" ? body.consentId : null;
  const validOperations = ["reference_sheet", "outfit", "video", "asset_registration"];
  if (!provider || !model || !operation || !validOperations.includes(operation)) {
    res.status(400).json({ error: "Invalid recipient acknowledgement." });
    return;
  }
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const subjectClass = routingSubjectClassFor(character);
  const surface = operation === "video" || operation === "asset_registration"
    ? "video" as const
    : "image" as const;
  const routing = resolveLikenessRouting({
    surface,
    provider,
    model,
    operation: operation as LikenessRecipientOperation,
    subjectClass,
  });
  if (!routing.allowed) {
    res.status(409).json({ error: routing.reason });
    return;
  }
  const providerLabel = surface === "image"
    ? getImageGenProviderDef(provider)?.label ?? provider
    : provider;
  const conflict = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(charactersTable)
      .where(and(eq(charactersTable.id, character.id), eq(charactersTable.tenantId, req.tenantId)))
      .for("update")
      .limit(1);
    if (!locked) return "gone";
    const [grant] = await tx
      .select()
      .from(characterLikenessConsentGrantsTable)
      .where(and(
        eq(characterLikenessConsentGrantsTable.tenantId, req.tenantId),
        eq(characterLikenessConsentGrantsTable.characterId, locked.id),
      ))
      .orderBy(
        desc(characterLikenessConsentGrantsTable.grantedAt),
        desc(characterLikenessConsentGrantsTable.id),
      )
      .limit(1);
    if (!grant) return "no_grant";
    if (consentId !== null && consentId !== grant.id) return "stale";
    await tx
      .insert(characterLikenessRecipientDisclosuresTable)
      .values({
        tenantId: req.tenantId,
        characterId: locked.id,
        consentId: grant.id,
        provider,
        model,
        operation: operation as LikenessRecipientOperation,
        scopeLabel: recipientScopeLabel({
          operation: operation as LikenessRecipientOperation,
          providerLabel,
          model,
        }),
        actingClerkUserId: req.clerkUserId,
      })
      .onConflictDoNothing();
    return null;
  });
  if (conflict === "no_grant") {
    res.status(409).json({
      error: "Attest to this likeness before acknowledging a recipient for it.",
    });
    return;
  }
  if (conflict) {
    res.status(409).json({ error: "The attestation changed. Reload before acknowledging a recipient." });
    return;
  }
  const current = await loadCharacter(req);
  res.status(201).json({ data: await likenessConsentDescriptor(current!, req.tenantId) });
});

/**
 * Withdraw one recipient without destroying the attestation. Stopping delivery
 * to a provider is not a statement that the person no longer consents to being
 * depicted at all, and the old all-or-nothing revoke could not express that.
 */
router.delete(
  "/characters/:characterId/likeness-recipients/:disclosureId",
  async (req: Request, res: Response) => {
    const disclosureId = Number(req.params.disclosureId);
    if (!Number.isInteger(disclosureId) || disclosureId <= 0) {
      res.status(400).json({ error: "Invalid recipient id." });
      return;
    }
    const character = await loadCharacter(req);
    if (!character) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [disclosure] = await db
      .select()
      .from(characterLikenessRecipientDisclosuresTable)
      .where(and(
        eq(characterLikenessRecipientDisclosuresTable.id, disclosureId),
        eq(characterLikenessRecipientDisclosuresTable.tenantId, req.tenantId),
        eq(characterLikenessRecipientDisclosuresTable.characterId, character.id),
      ))
      .limit(1);
    if (!disclosure) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db
      .insert(characterLikenessRecipientRevocationsTable)
      .values({
        tenantId: req.tenantId,
        characterId: character.id,
        disclosureId: disclosure.id,
        actingClerkUserId: req.clerkUserId,
      })
      .onConflictDoNothing();
    const current = await loadCharacter(req);
    res.json({ data: await likenessConsentDescriptor(current!, req.tenantId) });
  },
);

/**
 * The workspace-level declaration covering server-created generated cast,
 * which has no real subject and no user present when it is created. It is also
 * the record that a photorealistic generated face depicts nobody real — the
 * evidence for the reverse argument when a provider's classifier flags an AI
 * face as a possible real human.
 */
router.get("/characters/likeness-declaration", async (req: Request, res: Response) => {
  const declaration = await latestStandingDeclaration(req.tenantId);
  const policyVersion = likenessPolicyVersion();
  res.json({
    data: {
      statement: tenantStandingDeclarationStatement(),
      policyVersion,
      enforced: standingDeclarationEnforced(),
      status: !declaration
        ? "missing"
        : declaration.policyVersion !== policyVersion
          ? "stale"
          : "active",
      declaration: declaration
        ? {
            id: declaration.id,
            policyVersion: declaration.policyVersion,
            grantedAt: declaration.grantedAt.toISOString(),
          }
        : null,
    },
  });
});

router.post("/characters/likeness-declaration", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = new Set([
    "policyVersion",
    "fictionalOnlyConfirmed",
    "adultConfirmed",
    "noRealPersonConfirmed",
  ]);
  if (!Object.keys(body).every((key) => allowed.has(key))) {
    res.status(400).json({ error: "Invalid declaration." });
    return;
  }
  const policyVersion = likenessPolicyVersion();
  if (body.policyVersion !== policyVersion) {
    res.status(409).json({ error: "The declaration text changed. Reload and review it again." });
    return;
  }
  if (
    body.fictionalOnlyConfirmed !== true ||
    body.adultConfirmed !== true ||
    body.noRealPersonConfirmed !== true
  ) {
    res.status(400).json({ error: "All declaration confirmations are required." });
    return;
  }
  await db.insert(tenantLikenessStandingDeclarationsTable).values({
    tenantId: req.tenantId,
    policyVersion,
    statement: tenantStandingDeclarationStatement(),
    fictionalOnlyConfirmed: true,
    adultConfirmed: true,
    noRealPersonConfirmed: true,
    actingClerkUserId: req.clerkUserId,
  });
  const declaration = await latestStandingDeclaration(req.tenantId);
  res.status(201).json({
    data: {
      statement: tenantStandingDeclarationStatement(),
      policyVersion,
      enforced: standingDeclarationEnforced(),
      status: "active",
      declaration: declaration
        ? {
            id: declaration.id,
            policyVersion: declaration.policyVersion,
            grantedAt: declaration.grantedAt.toISOString(),
          }
        : null,
    },
  });
});


/**
 * Explicit, narrow recovery for a historical Guided character whose immutable
 * origin fields were never written. This endpoint never guesses from a label,
 * filename, payment, or current referenceSource. It requires the original
 * draft/role checkpoint, exact path and hash, and (when present) a matching
 * provider settlement receipt.
 */
router.post(
  "/characters/:characterId/provenance/recover",
  async (req: Request, res: Response) => {
    const characterId = Number(req.params.characterId);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const draftId = Number((body as Record<string, unknown>).draftId);
    const roleId = (body as Record<string, unknown>).roleId;
    if (
      !Number.isSafeInteger(draftId) ||
      draftId <= 0 ||
      typeof roleId !== "string" ||
      !roleId.trim() ||
      Object.keys(body).some((key) => key !== "draftId" && key !== "roleId")
    ) {
      res.status(400).json({
        error: "Provide the exact original Guided Story draftId and roleId.",
      });
      return;
    }
    const character = await loadCharacter(req);
    if (!character || character.id !== characterId) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (character.referenceSource !== null) {
      res.status(409).json({
        error: "Only a character with unknown origin can be explicitly recovered.",
      });
      return;
    }
    const [draft] = await db
      .select()
      .from(guidedStoryDraftsTable)
      .where(
        and(
          eq(guidedStoryDraftsTable.id, draftId),
          eq(guidedStoryDraftsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1);
    const operation = draft?.state.castOperations?.[roleId.trim()];
    const expectedOperationKey = `guided-story-cast:${draftId}:${draft?.revision ?? 0}:${roleId.trim()}`;
    if (
      !draft ||
      !operation ||
      operation.operationKey !== expectedOperationKey ||
      operation.status !== "uploaded" ||
      operation.characterId !== character.id ||
      operation.path !== character.referenceImagePath ||
      !operation.artifactHash ||
      !operation.provider ||
      !operation.model
    ) {
      res.status(409).json({
        error:
          "Exact immutable Guided generation evidence was not found; no metadata was changed.",
      });
      return;
    }
    let currentHash: string;
    try {
      currentHash = sha256Hex(
        (await loadReferenceImage(character.referenceImagePath, req.tenantId)).buffer,
      );
    } catch {
      res.status(409).json({
        error: "The original tenant-owned bytes could not be verified; no metadata was changed.",
      });
      return;
    }
    if (currentHash !== operation.artifactHash) {
      res.status(409).json({
        error: "The current bytes do not match the original Guided receipt; no metadata was changed.",
      });
      return;
    }
    let providerReceipt: typeof walletProviderOperationsTable.$inferSelect | null = null;
    if (operation.operationId != null) {
      const [receipt] = await db
        .select()
        .from(walletProviderOperationsTable)
        .where(
          and(
            eq(walletProviderOperationsTable.id, operation.operationId),
            eq(walletProviderOperationsTable.tenantId, req.tenantId),
          ),
        )
        .limit(1);
      providerReceipt = receipt ?? null;
      if (
        !receipt ||
        receipt.operationKind !== "character_reference" ||
        receipt.operationKey !== operation.operationKey ||
        receipt.provider !== operation.provider ||
        receipt.model !== operation.model ||
        !["succeeded", "settlement_queued", "settled"].includes(receipt.status)
      ) {
        res.status(409).json({
          error: "The original provider settlement receipt could not be verified; no metadata was changed.",
        });
        return;
      }
    }
    const recoveryValidation = validateExactRecoveryEvidence({
      tenantId: req.tenantId,
      characterTenantId: character.tenantId,
      draftId,
      roleId: roleId.trim(),
      currentPath: character.referenceImagePath,
      currentSha256: currentHash,
      checkpoint: {
        draftId,
        roleId: roleId.trim(),
        status: operation.status,
        sourcePath: operation.path,
        sourceSha256: operation.artifactHash,
        provider: operation.provider,
        model: operation.model,
        operationKey: operation.operationKey,
        operationId: operation.operationId ?? null,
      },
      providerReceipt,
    });
    if (!recoveryValidation.ok) {
      res.status(409).json({
        error: `${recoveryValidation.reason} No metadata was changed.`,
      });
      return;
    }
    const recovered = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(charactersTable)
        .where(
          and(
            eq(charactersTable.id, character.id),
            eq(charactersTable.tenantId, req.tenantId),
            isNull(charactersTable.referenceSource),
            eq(charactersTable.referenceImagePath, character.referenceImagePath),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) return null;
      const [updated] = await tx
        .update(charactersTable)
        .set({
          referenceSource: "generated",
          creationEvidence: null,
          updatedAt: new Date(),
        })
        .where(eq(charactersTable.id, locked.id))
        .returning();
      if (!updated) return null;
      const portraitProvenance = await captureAssetProvenance(tx, {
        tenantId: req.tenantId,
        assetKind: "character_reference",
        sourceKind: "textgenerated",
        characterId: updated.id,
        roleId: roleId.trim(),
        operationIdentity: operation.operationKey,
        provider: operation.provider!,
        model: operation.model!,
        providerOperationId: operation.operationId ?? null,
        artifactPath: updated.referenceImagePath,
        artifactSha256: currentHash,
        inputAncestry: {
          parents: [],
          referenceSource: "generated",
          capturedAt: new Date().toISOString(),
        },
      });
      const [evidenced] = await tx
        .update(charactersTable)
        .set({
          creationEvidence: {
            version: 1,
            kind: "guided_story",
            method: "textgenerated",
            draftId,
            draftRevision: draft.revision,
            roleId: roleId.trim(),
            operationKey: operation.operationKey,
            provider: operation.provider!,
            model: operation.model!,
            providerOperationId: operation.operationId ?? null,
            sourcePath: character.referenceImagePath,
            sourceSha256: currentHash,
            provenanceRecordId: portraitProvenance!.id,
            recordedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(charactersTable.id, updated.id))
        .returning();
      const [defaultOutfit] = await tx
        .select()
        .from(characterOutfitsTable)
        .where(
          and(
            eq(characterOutfitsTable.characterId, updated.id),
            eq(characterOutfitsTable.tenantId, req.tenantId),
            eq(characterOutfitsTable.isDefault, true),
            eq(characterOutfitsTable.referenceImagePath, updated.referenceImagePath),
          ),
        )
        .limit(1);
      if (defaultOutfit) {
        await captureAssetProvenance(tx, {
          tenantId: req.tenantId,
          assetKind: "character_outfit",
          sourceKind: "derived",
          characterId: updated.id,
          outfitId: defaultOutfit.id,
          roleId: roleId.trim(),
          operationIdentity: `${operation.operationKey}:outfit`,
          provider: operation.provider!,
          model: operation.model!,
          providerOperationId: operation.operationId ?? null,
          artifactPath: defaultOutfit.referenceImagePath,
          artifactSha256: currentHash,
          parentPath: updated.referenceImagePath,
          parentSha256: currentHash,
          inputAncestry: {
            parents: [{
              kind: "character_reference",
              path: updated.referenceImagePath,
              sha256: currentHash,
              characterId: updated.id,
            }],
            referenceSource: "generated",
            capturedAt: new Date().toISOString(),
          },
        });
      }
      return evidenced ?? updated;
    });
    if (!recovered) {
      res.status(409).json({
        error: "The character changed during recovery; reload and try again.",
      });
      return;
    }
    const outfits = await db
      .select()
      .from(characterOutfitsTable)
      .where(
        and(
          eq(characterOutfitsTable.characterId, recovered.id),
          eq(characterOutfitsTable.tenantId, req.tenantId),
        ),
      );
    res.json(serializeCharacter(recovered, outfits));
  },
);

router.post(
  "/characters/:characterId/reference-sheet/generate",
  async (req: Request, res: Response) => {
    const character = await loadCharacter(req);
    if (!character) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const updated = await generateAndPersistReferenceSheet(req, character);
    const outfits = await db
      .select()
      .from(characterOutfitsTable)
      .where(
        and(
          eq(characterOutfitsTable.characterId, character.id),
          eq(characterOutfitsTable.tenantId, req.tenantId),
        ),
      );
    if (updated.referenceSheetStatus === "failed") {
      res.status(502).json({
        error: updated.referenceSheetError ?? REFERENCE_SHEET_RETRY_MESSAGE,
        character: serializeCharacter(updated, outfits),
      });
      return;
    }
    res.json(serializeCharacter(updated, outfits));
  },
);

router.post(
  "/characters/:characterId/reference-sheet/:decision",
  async (req: Request, res: Response) => {
    const character = await loadCharacter(req);
    if (!character) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const decision = String(req.params.decision);
    if (decision !== "approve" && decision !== "reject") {
      res.status(400).json({ error: "Choose approve or reject." });
      return;
    }
    if (!character.referenceSheetImagePath) {
      res.status(409).json({ error: "Generate a reference sheet before reviewing it." });
      return;
    }
    if (
      decision === "approve" &&
      character.referenceSheetStatus !== "pending"
    ) {
      res.status(409).json({ error: "Only a pending reference sheet can be approved." });
      return;
    }
    let approvedSha256: string | null = null;
    if (decision === "approve") {
      try {
        approvedSha256 = createHash("sha256")
          .update((await loadReferenceImage(character.referenceSheetImagePath, req.tenantId)).buffer)
          .digest("hex");
      } catch {
        res.status(409).json({ error: "The reference sheet bytes could not be read for approval." });
        return;
      }
    }
    const updated = await db.transaction(async (tx) => {
      const [lockedCharacter] = await tx.select().from(charactersTable).where(and(
        eq(charactersTable.id, character.id),
        eq(charactersTable.tenantId, req.tenantId),
      )).for("update").limit(1);
      if (!lockedCharacter) return undefined;
      const lockedOutfits = await tx.select().from(characterOutfitsTable).where(and(
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
      )).orderBy(asc(characterOutfitsTable.id)).for("update");
      if (
        hasBlockingAtlasWork(lockedCharacter) ||
        lockedOutfits.some(hasBlockingAtlasWork)
      ) return undefined;
      const [row] = await tx.update(charactersTable).set({
        referenceSheetStatus: decision === "approve" ? "approved" : "rejected",
        referenceSheetApprovedSha256: approvedSha256,
        referenceSheetError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(charactersTable.id, character.id),
          eq(charactersTable.tenantId, req.tenantId),
          eq(charactersTable.referenceSheetImagePath, character.referenceSheetImagePath!),
          ...(decision === "approve"
            ? [eq(charactersTable.referenceSheetStatus, "pending")]
            : []),
        ),
      )
      .returning();
      return row;
    });
    if (!updated) {
      res.status(409).json({ error: "The reference sheet changed while it was being approved." });
      return;
    }
    const outfits = await db
      .select()
      .from(characterOutfitsTable)
      .where(
        and(
          eq(characterOutfitsTable.characterId, character.id),
          eq(characterOutfitsTable.tenantId, req.tenantId),
        ),
      );
    res.json(serializeCharacter(updated!, outfits));
  },
);

router.delete("/characters/:characterId", async (req: Request, res: Response) => {
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const atlasOutfits = await db.select()
    .from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.characterId, character.id),
      eq(characterOutfitsTable.tenantId, req.tenantId),
    ));
  try {
    await assertAtlasAssetsDeleted([
      {
        libraryRecordId: character.atlasAssetLibraryId,
        historicalId: character.atlasAssetId,
        submitFencedAt: character.atlasAssetSubmitFencedAt,
      },
      ...atlasOutfits.map((outfit) => ({
        libraryRecordId: outfit.atlasAssetLibraryId,
        historicalId: outfit.atlasAssetId,
        submitFencedAt: outfit.atlasAssetSubmitFencedAt,
      })),
    ]);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Atlas asset deletion could not be verified." });
    return;
  }
  let deletedOutfits: Array<{ assetId: string | null }>;
  try {
    deletedOutfits = await db.transaction(async (tx) => {
      const [lockedCharacter] = await tx.select()
        .from(charactersTable)
        .where(and(eq(charactersTable.id, character.id), eq(charactersTable.tenantId, req.tenantId)))
        .for("update")
        .limit(1);
      if (!lockedCharacter) throw new AtlasDeletionRaceError("Character changed during Atlas deletion validation.");
      const lockedOutfits = await tx.select().from(characterOutfitsTable).where(and(
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
      )).orderBy(asc(characterOutfitsTable.id)).for("update");
      if (
        hasBlockingAtlasWork(lockedCharacter) ||
        lockedOutfits.some(hasBlockingAtlasWork)
      ) {
        throw new AtlasDeletionRaceError(
          "Atlas registration or an outcome-unknown submission is active; deletion is blocked.",
        );
      }
       if (
         atlasDeletionSnapshot([lockedCharacter]) !== atlasDeletionSnapshot([character]) ||
         atlasDeletionSnapshot(lockedOutfits) !== atlasDeletionSnapshot(atlasOutfits)
       ) {
        throw new AtlasDeletionRaceError(
           "Atlas parent registration or outfit state changed during deletion validation. Retry after registration is reconciled.",
        );
      }
      const deleted = await tx.delete(characterOutfitsTable).where(and(
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
      )).returning({ assetId: characterOutfitsTable.bytePlusAssetId });
      await tx.delete(charactersTable).where(and(
        eq(charactersTable.id, character.id),
        eq(charactersTable.tenantId, req.tenantId),
      ));
      return deleted;
    });
  } catch (error) {
    if (error instanceof AtlasDeletionRaceError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.status(204).end();
  deleteBytePlusAssetsInBackground(deletedOutfits.map((row) => row.assetId));
});

router.get("/characters/identities", async (req: Request, res: Response) => {
  res.json((await listBytePlusIdentities(req.tenantId)).map((identity) => ({
    id: identity.id,
    label: identity.label,
    status: identity.status === "completing" ? "pending" : identity.status,
    retryable: identity.status === "failed",
    assetGroupId: identity.assetGroupId,
    error: identity.error,
    verifiedAt: identity.verifiedAt?.toISOString() ?? null,
  })));
});

router.post("/characters/identities", async (req: Request, res: Response) => {
  const parsed = StartBytePlusIdentityVerificationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "An identity label is required." });
    return;
  }
  const label = parsed.data.label.trim();
  let started: Awaited<ReturnType<typeof startBytePlusIdentityVerification>>;
  try {
    started = await startBytePlusIdentityVerification({
      tenantId: req.tenantId,
      label,
      callbackBaseUrl: `${canonicalAppOrigin()}/api/characters/identities/callback`,
      returnTarget: parsed.data.returnTarget ?? "web",
    });
  } catch (error) {
    if (error instanceof BytePlusIdentityConflictError) {
      res.status(409).json({
        error: error.message,
        status: error.status,
        retryable: false,
      });
      return;
    }
    req.log.warn({ err: error }, "BytePlus identity verification could not start");
    res.status(503).json({ error: "BytePlus identity verification is unavailable." });
    return;
  }
  res.status(201).json({
    id: started.identity.id,
    label: started.identity.label,
    status: started.identity.status,
    retryable: false,
    assetGroupId: null,
    error: null,
    verifiedAt: null,
    verificationUrl: started.verificationUrl,
    retried: started.retried,
  });
});

router.delete("/characters/identities/:identityId", async (req: Request, res: Response) => {
  const identityId = Number(req.params.identityId);
  if (!Number.isInteger(identityId) || identityId <= 0) {
    res.status(400).json({ error: "Invalid identity id." });
    return;
  }
  try {
    const result = await deleteBytePlusIdentity(req.tenantId, identityId);
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "Identity verification not found." });
      return;
    }
    if (result.outcome === "attached") {
      const names = result.characterNames.slice(0, 3).join(", ");
      res.status(409).json({
        error: `This verified identity is still used by ${names}. Delete ${
          result.characterNames.length === 1 ? "that character" : "those characters"
        } before removing the identity.`,
      });
      return;
    }
    res.status(204).end();
    deleteBytePlusIdentityAssetsInBackground(result.cleanupQueued);
  } catch (error) {
    if (hasDatabaseErrorCode(error, "23503")) {
      res.status(409).json({
        error: "This verified identity was attached to a character and cannot be removed.",
      });
      return;
    }
    throw error;
  }
});

function hasDatabaseErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

/** Public callback: authorization is the short-lived HMAC state, not a session cookie. */
export const bytePlusIdentityCallbackRouter: IRouter = Router();
bytePlusIdentityCallbackRouter.get(
  "/characters/identities/callback/:state",
  async (req: Request, res: Response) => {
    const outcome = await completeBytePlusIdentityVerification({
      state: String(req.params.state),
      bytedToken: typeof req.query.BytedToken === "string"
        ? req.query.BytedToken
        : typeof req.query.bytedToken === "string" ? req.query.bytedToken : undefined,
      resultCode: typeof req.query.resultCode === "string" ? req.query.resultCode : undefined,
    });
    const query = new URLSearchParams({
      identity: outcome.ok ? "verified" : "failed",
    });
    if (outcome.identityId) query.set("identityId", String(outcome.identityId));
    res.redirect(
      outcome.returnTarget === "mobile"
        ? `mobile://characters?${query.toString()}`
        : `/studio?${query.toString()}`,
    );
  },
);

router.patch("/characters/:characterId", async (req: Request, res: Response) => {
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const parsed = UpdateCharacterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a valid identity update." });
    return;
  }
  const region = parsed.data.protectedRegion;
  if (
    region &&
    (region.x + region.width > 1 || region.y + region.height > 1)
  ) {
    res.status(400).json({ error: "The protected region must stay inside the image." });
    return;
  }
  const identityId = parsed.data.identityId;
  if (identityId !== undefined) {
    if (character.referenceSource !== "uploaded") {
      res.status(400).json({
        error: "Only a character created from an uploaded photo can be verified.",
      });
      return;
    }
    if (
      character.bytePlusIdentityId !== null &&
      character.bytePlusIdentityId !== identityId
    ) {
      res.status(409).json({
        error: "This character is already attached to a different verified identity.",
      });
      return;
    }
    const identity = await getBytePlusIdentity(req.tenantId, identityId);
    if (identity?.status !== "verified" || !identity.assetGroupId) {
      res.status(400).json({
        error: "Choose a verified BytePlus identity owned by this workspace.",
      });
      return;
    }
  }
  const updated = await db.transaction(async (tx) => {
    const [lockedCharacter] = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.id, character.id),
      eq(charactersTable.tenantId, req.tenantId),
    )).for("update").limit(1);
    if (!lockedCharacter) return undefined;
    const lockedOutfits = await tx.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.characterId, character.id),
      eq(characterOutfitsTable.tenantId, req.tenantId),
    )).orderBy(asc(characterOutfitsTable.id)).for("update");
    if (
      hasBlockingAtlasWork(lockedCharacter) ||
      lockedOutfits.some(hasBlockingAtlasWork)
    ) return undefined;
    const [row] = await tx.update(charactersTable).set({
      ...(region ? { protectedRegion: region } : {}),
      ...(identityId !== undefined ? { bytePlusIdentityId: identityId } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(charactersTable.id, character.id),
      eq(charactersTable.tenantId, req.tenantId),
    )).returning();
    return row;
  });
  if (!updated) {
    res.status(409).json({ error: "Atlas registration is active; character edits are temporarily locked." });
    return;
  }
  const outfits = await db
    .select()
    .from(characterOutfitsTable)
    .where(
      and(
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
      ),
    );
  if (identityId !== undefined) {
    for (const outfit of outfits) {
      registerOutfitAssetInBackground({
        tenantId: req.tenantId,
        character: updated!,
        outfit,
      });
    }
  }
  res.json(serializeCharacter(updated, outfits));
});

/** Add a costume: an identity-preserving edit of the character's reference. */
router.post(
  "/characters/:characterId/outfits",
  async (req: Request, res: Response) => {
    const character = await loadCharacter(req);
    if (!character) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = CreateCharacterOutfitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const name = parsed.data.name.trim();
    const description = parsed.data.description.trim();
    const requestedRegion = parsed.data.protectedRegion;
    const protectedRegion = character.protectedRegion;
    if (!name || !description) {
      res.status(400).json({ error: "An outfit needs a name and a description." });
      return;
    }
    if (!protectedRegion) {
      res.status(409).json({
        error: "A reviewed protected face region is required before generating an outfit.",
      });
      return;
    }
    if (JSON.stringify(requestedRegion) !== JSON.stringify(protectedRegion)) {
      res.status(400).json({
        error: "The protected region must exactly match the character's reviewed region.",
      });
      return;
    }
    if (
      protectedRegion.x + protectedRegion.width > 1 ||
      protectedRegion.y + protectedRegion.height > 1
    ) {
      res.status(400).json({ error: "The protected region must stay inside the image." });
      return;
    }

    let funding: Funding | null = null;
    let successfulAiWork = false;
    const startedAt = Date.now();
    try {
      const baseReference = await loadReferenceImage(
        character.referenceImagePath,
        req.tenantId,
      );
      const likenessGate = await personalImageDispatchGate(
        character,
        sha256Hex(baseReference.buffer),
        "outfit",
      );
      funding = await reserveImageFunding(req, likenessGate.pinnedRecipient);
      if (!funding) {
        res.status(402).json({
          error:
            "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
        });
        return;
      }
      const reservedFunding = funding;
      const exactMaskedEdit = await createOutfitMaskedEdit(
        baseReference,
        protectedRegion,
      );
      const generated =
        funding.source === "wallet" && funding.reservation
          ? await executeWalletProviderOperation(
              {
                tenantId: req.tenantId,
                reservation: funding.reservation,
                operationKind: "character_outfit",
                operationKey: characterImageOperationKey(reservedFunding, `character-outfit:${character.id}:${name}`),
                settlement: {
                  kind: "image",
                  costPaise: null,
                  refKind: "character",
                  refId: String(character.id),
                },
              },
              (confirmSuccess) =>
                generateOutfitVariant(
                  character,
                  description,
                  baseReference,
                  {
                    tenantId: req.tenantId,
                    refKind: "character",
                    refId: String(character.id),
                    operationKey: characterImageOperationKey(reservedFunding, `character-outfit:${character.id}:${name}`),
                    funding: reservedFunding.meterFunding,
                  },
                  exactMaskedEdit,
                  (meta) => confirmSuccess(meta),
                  likenessGate.selectionPolicy,
                  likenessGate.beforeProviderDispatch,
                ),
              (result) => ({ provider: result.provider, model: result.model }),
              { isFailureConfirmed: isConfirmedImageFailure },
            )
          : null;
      const result =
        generated?.value ??
        (await generateOutfitVariant(
          character,
          description,
          baseReference,
          {
            tenantId: req.tenantId,
            refKind: "character",
            refId: String(character.id),
            operationKey: characterImageOperationKey(reservedFunding, `character-outfit:${character.id}:${name}`),
            funding: reservedFunding.meterFunding,
          },
          exactMaskedEdit,
          undefined,
          likenessGate.selectionPolicy,
          likenessGate.beforeProviderDispatch,
        ));
      successfulAiWork = true;
      await settleImageFunding(req, funding, {
        durationMs: Date.now() - startedAt,
        responseBytes: result.buffer.length,
        model: result.model,
        provider: result.provider,
      }, generated?.operationId);
      const referenceImagePath = await uploadBufferToStorage(
        req.tenantId,
        result.buffer,
        "image/png",
      );
      const sourceSha256 = sha256Hex(result.buffer);
      const baseSha256 = sha256Hex(baseReference.buffer);

      // Match character deletion's parent-then-children lock order. If
      // deletion already owns/removed the parent, this insert waits and then
      // observes no tenant-owned character; it must never create an orphan.
      const createdOutfit = await db.transaction(async (tx) => {
        const [lockedCharacter] = await tx.select()
          .from(charactersTable)
          .where(and(
            eq(charactersTable.id, character.id),
            eq(charactersTable.tenantId, req.tenantId),
          ))
          .for("update")
          .limit(1);
        if (!lockedCharacter) return null;
        if (lockedCharacter.referenceImagePath !== character.referenceImagePath) {
          return null;
        }
        const [inserted] = await tx
          .insert(characterOutfitsTable)
          .values({
            tenantId: req.tenantId,
            characterId: lockedCharacter.id,
            name,
            description,
            referenceImagePath,
            isDefault: false,
            status: "preview",
            identityVerified: true,
            canonicalReferenceImagePath: character.referenceImagePath,
            protectedRegion,
          })
          .returning();
        if (inserted) {
          await captureAssetProvenance(tx, {
            tenantId: req.tenantId,
            assetKind: "character_outfit",
            sourceKind: "imageedit",
            characterId: lockedCharacter.id,
            outfitId: inserted.id,
            operationIdentity: `character-outfit:${lockedCharacter.id}:${inserted.id}`,
            provider: result.provider,
            model: result.model,
            providerRequestId: result.providerRequestId ?? null,
            providerOperationId: generated?.operationId ?? null,
            artifactPath: referenceImagePath,
            artifactSha256: sourceSha256,
            parentPath: character.referenceImagePath,
            parentSha256: baseSha256,
            inputAncestry: {
              parents: [{
                kind: "character_reference",
                path: character.referenceImagePath,
                sha256: baseSha256,
                characterId: lockedCharacter.id,
              }],
              referenceSource:
                lockedCharacter.referenceSource === "uploaded"
                  ? "uploaded"
                  : lockedCharacter.referenceSource === "generated"
                    ? "generated"
                    : "unknown",
              capturedAt: new Date().toISOString(),
            },
          });
        }
        return inserted!;
      });
      if (!createdOutfit) {
        // This path was uploaded specifically for the outfit above and never
        // became referenced by a row. Delete it before reporting the race so
        // a deletion-winning parent cannot leave storage ownership orphaned.
        await objectStorage.deleteObjectEntity(referenceImagePath, req.tenantId);
        res.status(409).json({
          error: "The character was deleted while this outfit was being generated; no outfit was saved.",
        });
        return;
      }
      registerOutfitAssetInBackground({
        tenantId: req.tenantId,
        character,
        outfit: createdOutfit,
      });
      const outfits = await db
        .select()
        .from(characterOutfitsTable)
        .where(
          and(
            eq(characterOutfitsTable.characterId, character.id),
            eq(characterOutfitsTable.tenantId, req.tenantId),
          ),
        );
      res.status(201).json(serializeCharacter(character, outfits));
    } catch (caught) {
      let err = caught;
      if (err instanceof WalletProviderSuccessPersistenceError) successfulAiWork = true;
      if (err instanceof WalletProviderPostSuccessError) {
        successfulAiWork = true;
        const operationId = err.operationId;
        await settleWalletProviderOperationDurably(operationId).catch(
          (settlementError) =>
            req.log.error(
              { err: settlementError, operationId },
              "Failed to settle character image wallet charge",
            ),
        );
        err = err.originalError;
      }
      if (err instanceof ImagePreservationError && err.providerWorkCompleted) {
        successfulAiWork = true;
      }
      if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
      const { status, error } = imageErrorStatus(err);
      res.status(status).json({ error });
    }
  },
);

router.patch(
  "/characters/:characterId/outfits/:outfitId",
  async (req: Request, res: Response) => {
    const outfitId = Number(req.params.outfitId);
    const parsed = UpdateCharacterOutfitBody.safeParse(req.body);
    if (!Number.isInteger(outfitId) || outfitId <= 0 || !parsed.success) {
      res.status(400).json({ error: "Invalid outfit update." });
      return;
    }
    const character = await loadCharacter(req);
    if (!character) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [outfit] = await db
      .select()
      .from(characterOutfitsTable)
      .where(
        and(
          eq(characterOutfitsTable.id, outfitId),
          eq(characterOutfitsTable.characterId, character.id),
          eq(characterOutfitsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1);
    if (!outfit) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (outfit.isDefault) {
      res.status(400).json({ error: "The default outfit is already approved." });
      return;
    }
    if (parsed.data.status === "approved" && !outfit.identityVerified) {
      res.status(400).json({ error: "This outfit did not pass identity preservation." });
      return;
    }
    if (outfit.status === "rejected" && parsed.data.status === "approved") {
      res.status(400).json({ error: "A rejected preview cannot be approved." });
      return;
    }
    let approvedSha256: string | null | undefined;
    if (parsed.data.status === "approved") {
      try {
        approvedSha256 = createHash("sha256")
          .update((await loadReferenceImage(outfit.referenceImagePath, req.tenantId)).buffer)
          .digest("hex");
      } catch {
        res.status(409).json({ error: "The outfit bytes could not be read for approval." });
        return;
      }
    } else if (parsed.data.status) {
      approvedSha256 = null;
    }
    const updated = await db.transaction(async (tx) => {
      const [lockedCharacter] = await tx.select().from(charactersTable).where(and(
        eq(charactersTable.id, character.id),
        eq(charactersTable.tenantId, req.tenantId),
      )).for("update").limit(1);
      if (!lockedCharacter || hasBlockingAtlasWork(lockedCharacter)) return undefined;
      const [lockedOutfit] = await tx.select().from(characterOutfitsTable).where(and(
        eq(characterOutfitsTable.id, outfit.id),
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
      )).for("update").limit(1);
      if (!lockedOutfit || hasBlockingAtlasWork(lockedOutfit)) return undefined;
      const [row] = await tx.update(characterOutfitsTable).set({
        ...(parsed.data.name ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(approvedSha256 !== undefined ? { atlasApprovedSourceSha256: approvedSha256 } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(characterOutfitsTable.id, outfit.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.referenceImagePath, outfit.referenceImagePath),
        ...(parsed.data.status ? [eq(characterOutfitsTable.status, outfit.status)] : []),
      ))
      .returning();
      return row;
    });
    if (!updated) {
      res.status(409).json({ error: "The outfit changed while it was being approved." });
      return;
    }
    res.json(serializeOutfit(updated));
  },
);

router.delete(
  "/characters/:characterId/outfits/:outfitId",
  async (req: Request, res: Response) => {
    const outfitId = Number(req.params.outfitId);
    if (!Number.isInteger(outfitId) || outfitId <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const character = await loadCharacter(req);
    if (!character) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const outfit = (
      await db
        .select()
        .from(characterOutfitsTable)
        .where(
          and(
            eq(characterOutfitsTable.id, outfitId),
            eq(characterOutfitsTable.characterId, character.id),
            eq(characterOutfitsTable.tenantId, req.tenantId),
          ),
        )
        .limit(1)
    )[0];
    if (!outfit) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (outfit.isDefault) {
      res.status(400).json({ error: "The default outfit cannot be removed." });
      return;
    }
    try {
      await assertAtlasAssetsDeleted([{
        libraryRecordId: outfit.atlasAssetLibraryId,
        historicalId: outfit.atlasAssetId,
        submitFencedAt: outfit.atlasAssetSubmitFencedAt,
      }]);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Atlas asset deletion could not be verified." });
      return;
    }
    let deleted: { assetId: string | null } | undefined;
    try {
      deleted = await db.transaction(async (tx) => {
        const [lockedCharacter] = await tx.select()
          .from(charactersTable)
          .where(and(
            eq(charactersTable.id, character.id),
            eq(charactersTable.tenantId, req.tenantId),
          ))
          .for("update")
          .limit(1);
        if (!lockedCharacter) throw new AtlasDeletionRaceError("Character changed during Atlas deletion validation.");
        const [lockedOutfit] = await tx.select().from(characterOutfitsTable).where(and(
          eq(characterOutfitsTable.id, outfit.id),
          eq(characterOutfitsTable.characterId, character.id),
          eq(characterOutfitsTable.tenantId, req.tenantId),
        )).for("update").limit(1);
        if (
          hasBlockingAtlasWork(lockedCharacter) ||
          (lockedOutfit && hasBlockingAtlasWork(lockedOutfit))
        ) {
          throw new AtlasDeletionRaceError(
            "Atlas registration or an outcome-unknown submission is active; deletion is blocked.",
          );
        }
        if (
          !lockedOutfit ||
          atlasDeletionSnapshot([lockedOutfit]) !== atlasDeletionSnapshot([outfit])
        ) {
          throw new AtlasDeletionRaceError(
            "Atlas registration state changed during deletion validation. Retry after registration is reconciled.",
          );
        }
        const [row] = await tx.delete(characterOutfitsTable).where(and(
          eq(characterOutfitsTable.id, outfit.id),
          eq(characterOutfitsTable.characterId, character.id),
          eq(characterOutfitsTable.tenantId, req.tenantId),
        )).returning({ assetId: characterOutfitsTable.bytePlusAssetId });
        return row;
      });
    } catch (error) {
      if (error instanceof AtlasDeletionRaceError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
    deleteBytePlusAssetsInBackground([deleted?.assetId ?? null]);
    res.status(204).end();
  },
);

export default router;
