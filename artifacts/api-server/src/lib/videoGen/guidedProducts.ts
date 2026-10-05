import type {
  GuidedStoryDraftState,
  GuidedStoryProductChoices,
  GuidedStoryProductReference,
} from "@workspace/db";
import {
  BrandProductInputError,
  brandProductMetadata,
  loadBrandProduct,
  readBrandProductImage,
} from "../brandKit/products";
import { guidedProductId } from "./guidedStory";
import { readReferenceBytes, referenceDigest } from "./topicVideo/referenceImages";

/** A story promotes a handful of things well; more dilutes every scene. */
export const MAX_GUIDED_STORY_PRODUCTS = 4;

export class GuidedProductSelectionError extends Error {}

export type GuidedProductSelectionInput = {
  promotion: "subtle" | "featured";
  assetIds: number[];
};

type Setup = NonNullable<GuidedStoryDraftState["setup"]>;

/**
 * Freeze the selected Brand Kit products into the draft: copy their catalog
 * fields and pin the exact image bytes by hash. An AI description made from
 * different bytes than the current upload is dropped rather than trusted.
 */
export async function freezeGuidedProductSelection(params: {
  tenantId: number;
  brandKitId: number | null;
  selection: GuidedProductSelectionInput;
}): Promise<GuidedStoryProductChoices | null> {
  const assetIds = [...new Set(params.selection.assetIds)];
  if (!assetIds.length) return null;
  if (assetIds.length > MAX_GUIDED_STORY_PRODUCTS) {
    throw new GuidedProductSelectionError(
      `Choose at most ${MAX_GUIDED_STORY_PRODUCTS} products or services for one story.`,
    );
  }
  if (params.brandKitId === null) {
    throw new GuidedProductSelectionError(
      "Choose a Brand Kit before selecting products or services to promote.",
    );
  }
  const items: GuidedStoryProductReference[] = [];
  for (const assetId of assetIds) {
    const row = await loadBrandProduct(params.tenantId, params.brandKitId, assetId);
    if (!row) {
      throw new GuidedProductSelectionError(
        "A selected product is not in this Brand Kit. Refresh and choose again.",
      );
    }
    const meta = brandProductMetadata(row);
    let image: Awaited<ReturnType<typeof readBrandProductImage>>;
    try {
      image = await readBrandProductImage(row.fileUrl, params.tenantId);
    } catch (error) {
      if (error instanceof BrandProductInputError) {
        throw new GuidedProductSelectionError(
          `"${meta.name}" has an unreadable image. Upload it again in the Brand Kit.`,
        );
      }
      throw error;
    }
    items.push({
      id: guidedProductId(row.id),
      assetId: row.id,
      name: meta.name,
      kind: meta.kind,
      description: meta.description,
      aiDescription:
        meta.aiDescriptionStatus === "ready" && meta.imageSha256 === image.sha256
          ? meta.aiDescription
          : null,
      displayMode: meta.displayMode,
      imagePath: row.fileUrl,
      imageSha256: image.sha256,
      mimeType: image.mimeType,
    });
  }
  return { version: 1, promotion: params.selection.promotion, items };
}

/**
 * Products for a saved setup. An omitted selection keeps the current one,
 * but only while the Brand Kit is unchanged — products never cross kits.
 */
export async function resolveGuidedSetupProducts(params: {
  tenantId: number;
  setup: Setup;
  selection: GuidedProductSelectionInput | undefined;
  previous: Setup | null;
}): Promise<GuidedStoryProductChoices | null> {
  if (params.selection) {
    return freezeGuidedProductSelection({
      tenantId: params.tenantId,
      brandKitId: params.setup.brandKitId,
      selection: params.selection,
    });
  }
  const previous = params.previous?.products ?? null;
  return previous && params.previous?.brandKitId === params.setup.brandKitId
    ? previous
    : null;
}

/** Enqueue-time proof that every frozen product image is still the approved one. */
export async function assertGuidedProductsUnchanged(
  products: GuidedStoryProductChoices | null | undefined,
  tenantId: number,
): Promise<string | null> {
  for (const item of products?.items ?? []) {
    const bytes = await readReferenceBytes(item.imagePath, tenantId).catch(() => null);
    if (!bytes || referenceDigest(bytes) !== item.imageSha256) {
      return `The image for "${item.name}" changed or was removed after this story was set up. Re-select your products in the story setup.`;
    }
  }
  return null;
}
