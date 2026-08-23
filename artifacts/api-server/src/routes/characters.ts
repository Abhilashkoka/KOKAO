import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, charactersTable, characterOutfitsTable } from "@workspace/db";
import type { Character, CharacterOutfit } from "@workspace/db";
import { and, eq, asc, inArray } from "drizzle-orm";
import { CreateCharacterBody, CreateCharacterOutfitBody } from "@workspace/api-zod";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import {
  isWalletFunded,
  reserveWallet,
  settleWallet,
  refundWallet,
  type WalletReservation,
} from "../lib/wallet";
import { recordUsage } from "../lib/usage";
import { uploadBufferToStorage } from "../lib/storageUpload";
import {
  CharacterInputError,
  loadReferenceImage,
  generateCharacterReference,
  generateOutfitVariant,
} from "../lib/characters";
import { ImageGenNotConfiguredError, ImageGenProviderError } from "../lib/imageGen/types";

const router: IRouter = Router();

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
async function reserveImageFunding(req: Request): Promise<Funding | null> {
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

async function settleImageFunding(
  req: Request,
  funding: Funding,
  meta: { durationMs: number; responseBytes: number; model: string; provider: string },
): Promise<void> {
  if (funding.source === "wallet" && funding.reservation) {
    // Character references go through a helper that does not surface a
    // provider cost, so this settles at the admin display rate (flagged
    // `estimated` in the ledger) rather than charging nothing.
    await settleWallet(req.tenantId, funding.reservation, {
      kind: "image",
      costPaise: null,
      provider: meta.provider,
      model: meta.model,
    }).catch((err) =>
      req.log.error({ err }, "Failed to settle character image wallet charge"),
    );
  }
  await recordUsage(req.tenantId, "image", { ...meta, funding: funding.source }).catch((err) =>
    req.log.error({ err }, "Failed to record character image usage after successful work"),
  );
}

async function releaseImageFunding(req: Request, funding: Funding): Promise<void> {
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
  return { status: 500, error: "Something went wrong. Please try again." };
}

router.get("/characters", async (req: Request, res: Response) => {
  const characters = await db
    .select()
    .from(charactersTable)
    .where(eq(charactersTable.tenantId, req.tenantId))
    .orderBy(asc(charactersTable.id));
  if (characters.length === 0) {
    res.json([]);
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
    characters.map((c) =>
      serializeCharacter(
        c,
        outfits.filter((o) => o.characterId === c.id),
      ),
    ),
  );
});

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
      const result = await generateCharacterReference(description);
      referenceImagePath = await uploadBufferToStorage(req.tenantId, result.buffer, "image/png");
      await settleImageFunding(req, funding, {
        durationMs: Date.now() - startedAt,
        responseBytes: result.buffer.length,
        model: result.model,
        provider: result.provider,
      });
    }
  } catch (err) {
    if (funding) await releaseImageFunding(req, funding);
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
    if (funding) await releaseImageFunding(req, funding);
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
    if (!name || !description) {
      res.status(400).json({ error: "An outfit needs a name and a description." });
      return;
    }

    let funding: Funding | null = null;
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
      const result = await generateOutfitVariant(character, description, baseReference);
      const referenceImagePath = await uploadBufferToStorage(
        req.tenantId,
        result.buffer,
        "image/png",
      );
      await settleImageFunding(req, funding, {
        durationMs: Date.now() - startedAt,
        responseBytes: result.buffer.length,
        model: result.model,
        provider: result.provider,
      });

      await db
        .insert(characterOutfitsTable)
        .values({
          tenantId: req.tenantId,
          characterId: character.id,
          name,
          description,
          referenceImagePath,
          isDefault: false,
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
    } catch (err) {
      if (funding) await releaseImageFunding(req, funding);
      const { status, error } = imageErrorStatus(err);
      res.status(status).json({ error });
    }
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
