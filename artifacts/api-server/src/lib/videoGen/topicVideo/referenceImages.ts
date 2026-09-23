import { createHash } from "node:crypto";
import sharp from "sharp";
import type { VideoJobOptions } from "@workspace/db";
import type { VideoReferenceImage } from "@workspace/api-zod";
import { ObjectStorageService } from "../../objectStorage";
import { effectiveModel, getImageGenSelection, getImageGenProviderDef, isImageGenProviderConfigured, rankImageGenProviders, resolveImageGenProviderDef, supportsReferenceInput } from "../../imageGen";

export type FrozenReferenceImage = NonNullable<VideoJobOptions["referenceImages"]>[number];
const MAX_BYTES = 10 * 1024 * 1024;
const storage = new ObjectStorageService();
export const referenceDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Never resolve a URL, traversal, or another tenant's storage namespace. */
export function assertReferencePath(path: string, tenantId: number): void {
  if (!path.startsWith(`/objects/${tenantId}/`) ||
      /[\\%?#]/.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Reference images must be uploads owned by this workspace.");
  }
}

export async function readReferenceBytes(path: string, tenantId: number): Promise<Buffer> {
  assertReferencePath(path, tenantId);
  const file = await storage.getObjectEntityFile(path, tenantId);
  const [metadata] = await file.getMetadata();
  if (!Number.isFinite(Number(metadata.size)) || Number(metadata.size) > MAX_BYTES) {
    throw new Error("Reference images must be at most 10 MB.");
  }
  // Limit the stream too: metadata alone is not a byte-size boundary.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.createReadStream()) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("Reference images must be at most 10 MB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function validateReferenceContent(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Reference images must be between 1 byte and 10 MB.");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
      throw new Error("Unsupported image");
    }
    // Force a real decode before funding, not merely a header sniff.
    await image.raw().toBuffer();
    return `image/${metadata.format}`;
  } catch {
    throw new Error("Reference must be a valid, non-animated PNG, JPEG, or WebP (maximum 40 megapixels).");
  }
}

export function validateReferenceMappings(references: VideoReferenceImage[], sceneCount: number): void {
  if (references.length > 6) throw new Error("At most 6 reference images are supported.");
  if (references.some((ref) => !ref.id.trim() || !ref.label.trim())) throw new Error("Every reference needs a non-blank ID and label.");
  if (new Set(references.map((ref) => ref.id)).size !== references.length) throw new Error("Reference image IDs must be unique.");
  const claimed = new Set<number>();
  for (const ref of references) {
    for (const number of new Set(ref.sceneNumbers ?? [])) {
      if (!Number.isInteger(number) || number < 1 || number > sceneCount) throw new Error(`Reference "${ref.label}" maps outside the ${sceneCount} planned scenes.`);
      if (claimed.has(number)) throw new Error(`Scene ${number} has multiple references. Choose distinct scenes for each image.`);
      claimed.add(number);
    }
  }
  const automatic = references.filter((ref) => !ref.sceneNumbers?.length).length;
  if (automatic > sceneCount - claimed.size) throw new Error("Not enough unassigned scenes for every reference. Increase video length or choose distinct scene numbers.");
}

export async function freezeReferenceImages(references: VideoReferenceImage[], tenantId: number, sceneCount: number) {
  validateReferenceMappings(references, sceneCount);
  const frozen: FrozenReferenceImage[] = [];
  let firstVisual: { buffer: Buffer; mimeType: string } | undefined;
  for (const ref of references) {
    const bytes = await readReferenceBytes(ref.objectPath, tenantId);
    const mimeType = await validateReferenceContent(bytes);
    frozen.push({ ...ref, sha256: referenceDigest(bytes), mimeType });
    if (ref.mode === "visual_reference") firstVisual ??= { buffer: bytes, mimeType };
  }
  let selection: VideoJobOptions["referenceImageSelection"];
  if (firstVisual) {
    selection = await getImageGenSelection();
    if (selection.provider === "auto") {
      const winner = (await rankImageGenProviders(firstVisual))[0];
      const def = winner && getImageGenProviderDef(winner.id);
      if (!def) throw new Error("No reference-capable image model is configured. Choose exact insert or configure an image-input model.");
      selection = { ...selection, provider: def.id, model: def.defaultModel };
    }
    const def = await resolveImageGenProviderDef(selection.provider);
    if (!def || !supportsReferenceInput(def, effectiveModel(def, selection.model)) || !(await isImageGenProviderConfigured(def))) {
      throw new Error("The selected image model cannot use uploaded references. Choose exact insert or select a reference-capable image model.");
    }
  }
  return { references: frozen, selection };
}

export async function loadFrozenReference(ref: FrozenReferenceImage, tenantId: number) {
  const buffer = await readReferenceBytes(ref.objectPath, tenantId);
  if (referenceDigest(buffer) !== ref.sha256) throw new Error(`Reference "${ref.label}" changed after submission. Start a new video with the updated upload.`);
  return { buffer, mimeType: ref.mimeType };
}

/** Deterministic semantic allocation, frozen on the board; never drop an input. */
export function assignReferenceImages(references: FrozenReferenceImage[], scenes: { text: string }[]): string[][] {
  validateReferenceMappings(references, scenes.length);
  const mapping = scenes.map(() => [] as string[]);
  for (const ref of references) for (const n of ref.sceneNumbers ?? []) mapping[n - 1] = [ref.id];
  for (const ref of references.filter((ref) => !ref.sceneNumbers?.length)) {
    const words = `${ref.label} ${ref.instructions}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const ranked = scenes.map((scene, i) => ({
      i, score: (scene.text.toLowerCase().includes(ref.label.toLowerCase()) ? 10 : 0) +
        words.filter((word) => !["the", "and", "show", "this", "with", "image", "use"].includes(word) && scene.text.toLowerCase().includes(word)).length,
    })).filter(({ i }) => !mapping[i]!.length).sort((a, b) => b.score - a.score || a.i - b.i);
    mapping[ranked[0]!.i] = [ref.id];
  }
  return mapping;
}

export function referenceBrief(references: FrozenReferenceImage[]): string {
  if (!references.length) return "";
  return "\nUploaded prop/product/screenshot references (not characters). Integrate each subject into the script and scene directions. Do not read these production notes aloud:\n" +
    references.map((ref) => `${ref.id}: ${ref.label}. ${ref.instructions}. ${ref.mode}. Scenes: ${ref.sceneNumbers?.join(", ") || "allocate to the most relevant scene"}`).join("\n");
}