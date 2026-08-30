import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  charactersTable,
  characterOutfitsTable,
  presetCharactersTable,
  presetOutfitDerivativesTable,
} from "@workspace/db";
import type { Character, CharacterOutfit, PresetCharacter } from "@workspace/db";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import {
  CreateCharacterBody,
  CreateCharacterOutfitBody,
  UpdateCharacterBody,
  UpdateCharacterOutfitBody,
  UpdatePresetOutfitDerivativeBody,
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
import {
  CharacterInputError,
  loadReferenceImage,
  generateCharacterReference,
  generateOutfitVariant,
  createOutfitMaskedEdit,
} from "../lib/characters";
import {
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  ImagePreservationError,
} from "../lib/imageGen/types";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import {
  ensurePresetCharacterSeeds,
  bundledPresetAsset,
  getPresetForTenant,
  listTenantPresetDerivatives,
} from "../lib/presetCharacters";

const router: IRouter = Router();

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
  if (error instanceof ImagePreservationError) {
    return !error.providerWorkCompleted;
  }
  if (error instanceof ImageGenNotConfiguredError || error instanceof CharacterInputError) {
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

/** Per-tenant cap: characters are curated identities, not a media library. */
export const MAX_CHARACTERS = 5;

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

function serializeCharacter(character: Character, outfits: CharacterOutfit[]) {
  const ordered = [...outfits].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id,
  );
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    referenceImagePath: character.referenceImagePath,
    protectedRegion: character.protectedRegion,
    outfits: ordered.map(serializeOutfit),
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
  };
}

interface Funding {
  source: "quota" | "credit" | "wallet";
  reservation?: WalletReservation;
}

/**
 * Reserve image funding on whichever rail this workspace is on: the rupee
 * wallet, or the original quota-then-credit path. Null → caller 402s.
 */
export async function reserveImageFunding(req: Request): Promise<Funding | null> {
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) return null;
  if (await isWalletFunded(req.tenantId)) {
    const reservation = await reserveWallet(req.tenantId, "image");
    return reservation ? { source: "wallet", reservation } : null;
  }
  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.images === -1 || usage.images < limits.images) return { source: "quota" };
  if (await spendCredit(req.tenantId, "image")) return { source: "credit" };
  return null;
}

export async function settleImageFunding(
  req: Request,
  funding: Funding,
  meta: { durationMs: number; responseBytes: number; model: string; provider: string },
  operationId?: number,
): Promise<void> {
  if (funding.source === "wallet" && funding.reservation) {
    if (!operationId) {
      throw new Error("Wallet-funded character image is missing its provider operation");
    }
    await settleWalletProviderOperationDurably(operationId);
  }
  await recordUsage(req.tenantId, "image", { ...meta, funding: funding.source }).catch((err) =>
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
  if (err instanceof CharacterInputError) return { status: 400, error: err.message };
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
        exactMaskedEdit,
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
    const [created] = await db
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
  let funding: Funding | null = null;
  let successfulAiWork = false;
  const startedAt = Date.now();
  try {
    if (sourceImagePath) {
      // Uploaded photo: validate it exists, is an image, and fits; no AI cost.
      await loadReferenceImage(sourceImagePath, req.tenantId);
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
      const generated =
        funding.source === "wallet" && funding.reservation
          ? await executeWalletProviderOperation(
              {
                tenantId: req.tenantId,
                reservation: funding.reservation,
                operationKind: "character_reference",
                operationKey: `character-reference:${req.tenantId}:${name}`,
                settlement: {
                  kind: "image",
                  costPaise: null,
                  refKind: "character",
                  refId: name,
                },
              },
              () => generateCharacterReference(description),
              (result) => ({ provider: result.provider, model: result.model }),
              { isFailureConfirmed: isConfirmedImageFailure },
            )
          : null;
      const result = generated?.value ?? (await generateCharacterReference(description));
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
    }
  } catch (err) {
    if (err instanceof WalletProviderSuccessPersistenceError) successfulAiWork = true;
    if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
    const { status, error } = imageErrorStatus(err);
    res.status(status).json({ error });
    return;
  }

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
        .values({ tenantId: req.tenantId, name, description, referenceImagePath })
        .returning()
    )[0]!;
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
        })
        .returning()
    )[0]!;
    return { character, defaultOutfit };
  });
  if (!created) {
    if (funding && !successfulAiWork) await releaseImageFunding(req, funding);
    res.status(400).json({
      error: `You can save up to ${MAX_CHARACTERS} characters. Delete one to add another.`,
    });
    return;
  }
  res.status(201).json(serializeCharacter(created.character, [created.defaultOutfit]));
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

router.delete("/characters/:characterId", async (req: Request, res: Response) => {
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db
    .delete(characterOutfitsTable)
    .where(
      and(
        eq(characterOutfitsTable.characterId, character.id),
        eq(characterOutfitsTable.tenantId, req.tenantId),
      ),
    );
  await db
    .delete(charactersTable)
    .where(and(eq(charactersTable.id, character.id), eq(charactersTable.tenantId, req.tenantId)));
  res.status(204).end();
});

router.patch("/characters/:characterId", async (req: Request, res: Response) => {
  const character = await loadCharacter(req);
  if (!character) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const parsed = UpdateCharacterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a valid face and hair region." });
    return;
  }
  const region = parsed.data.protectedRegion;
  if (region.x + region.width > 1 || region.y + region.height > 1) {
    res.status(400).json({ error: "The protected region must stay inside the image." });
    return;
  }
  const [updated] = await db
    .update(charactersTable)
    .set({ protectedRegion: region, updatedAt: new Date() })
    .where(
      and(
        eq(charactersTable.id, character.id),
        eq(charactersTable.tenantId, req.tenantId),
      ),
    )
    .returning();
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
    const protectedRegion = parsed.data.protectedRegion;
    if (!name || !description) {
      res.status(400).json({ error: "An outfit needs a name and a description." });
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
      funding = await reserveImageFunding(req);
      if (!funding) {
        res.status(402).json({
          error:
            "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
        });
        return;
      }
      const baseReference = await loadReferenceImage(
        character.referenceImagePath,
        req.tenantId,
      );
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
                operationKey: `character-outfit:${character.id}:${name}`,
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
          exactMaskedEdit,
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

      await db
        .insert(characterOutfitsTable)
        .values({
          tenantId: req.tenantId,
          characterId: character.id,
          name,
          description,
          referenceImagePath,
          isDefault: false,
          status: "preview",
          identityVerified: true,
          canonicalReferenceImagePath: character.referenceImagePath,
          protectedRegion,
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
    const [updated] = await db
      .update(characterOutfitsTable)
      .set({
        ...(parsed.data.name ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(characterOutfitsTable.id, outfit.id))
      .returning();
    res.json(serializeOutfit(updated!));
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
    await db
      .delete(characterOutfitsTable)
      .where(eq(characterOutfitsTable.id, outfit.id));
    res.status(204).end();
  },
);

export default router;
