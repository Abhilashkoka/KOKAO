import type { VideoStoryboardScene } from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { VideoGenProviderError } from "./types";
import { guidedInScenePhotoProducts } from "./guidedStory";
import { readReferenceBytes, referenceDigest } from "./topicVideo/referenceImages";

type GuidedSceneVisuals = NonNullable<VideoStoryboardScene["guidedStory"]>["visuals"];
type SceneProduct = NonNullable<GuidedSceneVisuals["products"]>[number];

const SIGNED_URL_TTL_SECONDS = 15 * 60;
const storage = new ObjectStorageService();

/** Load a frozen product photo and prove it is the exact approved upload. */
export async function loadApprovedProductImage(
  product: Pick<SceneProduct, "name" | "imagePath" | "imageSha256">,
  tenantId: number,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readReferenceBytes(product.imagePath, tenantId);
  } catch {
    throw new VideoGenProviderError(
      `The product image for "${product.name}" is no longer available. Re-select it in the story setup and start again.`,
    );
  }
  if (referenceDigest(bytes) !== product.imageSha256) {
    throw new VideoGenProviderError(
      `The product image for "${product.name}" changed after the script was approved. Re-select it in the story setup and start again.`,
    );
  }
  return bytes;
}

/**
 * Extra Wan `refers` for a scene that shows in-scene products, appended after
 * the cast pairs. The prompt labels these positions as cast…, backdrop,
 * products, so when products are attached the approved backdrop plate is
 * attached too — otherwise every product label would be off by one.
 * Scenes without in-scene products return [] and keep their exact legacy
 * request shape.
 */
export async function guidedWanProductReferenceUrls(params: {
  tenantId: number;
  visuals: GuidedSceneVisuals | undefined;
}): Promise<string[]> {
  const products = guidedInScenePhotoProducts(params.visuals?.products);
  if (!products.length) return [];
  const urls: string[] = [];
  const backdropPath = params.visuals?.backdropReferencePath;
  if (backdropPath) {
    if (params.visuals?.backdropImageSha256) {
      const bytes = await readReferenceBytes(backdropPath, params.tenantId).catch(() => null);
      if (!bytes || referenceDigest(bytes) !== params.visuals.backdropImageSha256) {
        throw new VideoGenProviderError(
          "This scene's approved backdrop no longer matches its approval. Re-approve the backdrop and start again.",
        );
      }
    }
    urls.push(
      await storage.getSignedDownloadURL(backdropPath, params.tenantId, SIGNED_URL_TTL_SECONDS),
    );
  }
  for (const product of products) {
    await loadApprovedProductImage(product, params.tenantId);
    urls.push(
      await storage.getSignedDownloadURL(product.imagePath, params.tenantId, SIGNED_URL_TTL_SECONDS),
    );
  }
  return urls;
}

/** Exact-mode products for a scene, with verified bytes, for the card overlay. */
export async function guidedExactProductCards(params: {
  tenantId: number;
  visuals: GuidedSceneVisuals | undefined;
}): Promise<Array<{ name: string; image: Buffer }>> {
  const exact = (params.visuals?.products ?? []).filter(
    (product) => product.displayMode === "exact",
  );
  const cards: Array<{ name: string; image: Buffer }> = [];
  for (const product of exact) {
    cards.push({
      name: product.name,
      image: await loadApprovedProductImage(product, params.tenantId),
    });
  }
  return cards;
}
