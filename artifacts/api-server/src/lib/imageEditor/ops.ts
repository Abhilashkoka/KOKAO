import sharp from "sharp";
import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import type { Tenant } from "@workspace/db";
import { ImageGenProviderError } from "../imageGen";
import { OPENAI_BUILTIN_MODEL } from "../imageGen/providers/openaiBuiltin";
import { performImageEdit, type ImageEditOutcome } from "../imageEdit";
import { uploadBufferToStorage } from "../storageUpload";
import { buildImageCostMeta } from "../aiCost";
import type { UsageMeta } from "../usage";

/**
 * The AI operations behind the editor's generative tools.
 *
 * Every one of these is, underneath, the same provider primitive the editor
 * already had: `images.edit` with a mask, where transparent means regenerate.
 * What differs is who builds the mask and what the prompt says, and that is
 * the whole reason they live here rather than being six prompts typed into the
 * existing repair box:
 *
 *  - **Fill** is the raw primitive: the user's selection, the user's prompt.
 *  - **Remove** is the same call with a prompt written to forbid invention.
 *    Left to their own words people write "remove the cup" into a field whose
 *    contract is "describe what should be here", and get a second cup.
 *  - **Replace background** inverts the subject mask for them.
 *  - **Expand** is the interesting one: an outpaint is an inpaint on a bigger
 *    canvas where the mask is everything the original does not cover. The
 *    canvas arithmetic is here because getting it wrong by a pixel leaves a
 *    seam, and because the provider only accepts three output sizes.
 *  - **Cutout** is the only one that is not an inpaint — it asks for the
 *    subject on a transparent background, which is what turns a flat photo
 *    into layers that this editor can actually work with.
 *  - **Enlarge** is deliberately NOT an AI call. See the note on it below.
 */

export type ImageOp = "fill" | "remove" | "replace-background" | "expand" | "cutout" | "enlarge";

export class ImageOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageOpError";
  }
}

export interface ImageOpLayer {
  objectPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
}

export interface ImageOpBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageOpOutcome {
  imagePath: string | null;
  b64Json: string | null;
  width: number;
  height: number;
  /** Where the original ended up in the result; the full frame unless expanded. */
  sourceBox: ImageOpBox;
  layers: ImageOpLayer[] | null;
  meta: Omit<UsageMeta, "funding"> | null;
  /** Billable image generations this call actually made. */
  units: number;
}

/**
 * What each op costs, before it runs.
 *
 * The route reserves against this and the client shows it, so the number the
 * user agreed to is the number they are charged. `enlarge` is zero because it
 * never reaches a provider.
 */
export const OP_UNITS: Record<ImageOp, number> = {
  fill: 1,
  remove: 1,
  "replace-background": 1,
  expand: 1,
  cutout: 1,
  enlarge: 0,
};

/** Output sizes the image provider will return. Nothing else is accepted. */
const PROVIDER_SIZES: Array<{ width: number; height: number }> = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

/**
 * Wording matters more here than anywhere else in the file.
 *
 * "Remove the object" reads to an image model as "here is a region, put
 * something in it", and it obliges. Naming the failure mode explicitly —
 * no new objects — is what makes removal actually remove.
 */
const REMOVE_PROMPT =
  "Erase whatever is in the transparent region and continue the surrounding scene through it. " +
  "Match the existing lighting, colour, grain and perspective exactly. " +
  "Do not add any new object, person, animal, text or decoration. The result must look like nothing was ever there.";

const EXPAND_PROMPT_PREFIX =
  "Extend this photograph outwards into the transparent area. Continue the existing scene, lighting, " +
  "colour grade, grain and perspective seamlessly, with no visible seam or border. Do not repeat the subject. ";

const CUTOUT_PROMPT =
  "Return the main subject of this image cut out precisely, on a fully transparent background. " +
  "Keep the subject's original colours, lighting and detail unchanged. Preserve fine edges such as hair and fur. " +
  "Do not add a shadow, a backdrop, or any new element.";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function dimensionsOf(buffer: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buffer).metadata();
  if (typeof meta.width !== "number" || typeof meta.height !== "number") {
    throw new ImageOpError("Could not read the image dimensions.");
  }
  return { width: meta.width, height: meta.height };
}

/**
 * The provider size that best fits a requested expansion.
 *
 * Picks by aspect ratio rather than by area: an expansion is a shape change,
 * and landing on a size with the wrong orientation would ask the model to
 * outpaint in the axis the user was not extending.
 */
function providerSizeFor(width: number, height: number): { width: number; height: number } {
  const target = width / height;
  let best = PROVIDER_SIZES[0];
  let bestDelta = Infinity;
  for (const size of PROVIDER_SIZES) {
    const delta = Math.abs(size.width / size.height - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = size;
    }
  }
  return best;
}

/** Fully transparent PNG of the given size — the base for a generated mask. */
async function transparentCanvas(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

/** Opaque black PNG — the "keep this" region of a mask. */
async function opaqueCanvas(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/* ------------------------------------------------------------------ *
 * Expand
 * ------------------------------------------------------------------ */

interface ExpandPlan {
  canvas: { width: number; height: number };
  placement: { left: number; top: number; width: number; height: number };
}

/**
 * Work out where the original sits inside the expanded canvas.
 *
 * The requested padding is treated as a direction and a ratio rather than an
 * exact pixel count, because the output size is not ours to choose — the
 * provider has three. So the original is scaled to fit the chosen canvas while
 * keeping every requested edge at least as generous as asked, and centred
 * according to the balance of the request: pad only on the left, and the
 * original ends up on the right.
 */
export function planExpansion(
  source: { width: number; height: number },
  pad: { left: number; right: number; top: number; bottom: number },
): ExpandPlan {
  const requestedWidth = source.width + Math.max(0, pad.left) + Math.max(0, pad.right);
  const requestedHeight = source.height + Math.max(0, pad.top) + Math.max(0, pad.bottom);
  const canvas = providerSizeFor(requestedWidth, requestedHeight);

  // Scale the original down just enough that the full requested padding fits.
  const scale = Math.min(canvas.width / requestedWidth, canvas.height / requestedHeight, 1);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const spareX = canvas.width - width;
  const spareY = canvas.height - height;
  const totalX = Math.max(1, Math.max(0, pad.left) + Math.max(0, pad.right));
  const totalY = Math.max(1, Math.max(0, pad.top) + Math.max(0, pad.bottom));

  const left = Math.round(spareX * (Math.max(0, pad.left) / totalX));
  const top = Math.round(spareY * (Math.max(0, pad.top) / totalY));

  return {
    canvas,
    placement: {
      left: Math.max(0, Math.min(canvas.width - width, left)),
      top: Math.max(0, Math.min(canvas.height - height, top)),
      width,
      height,
    },
  };
}

async function buildExpandInputs(
  sourceBuffer: Buffer,
  plan: ExpandPlan,
): Promise<{ image: Buffer; mask: Buffer }> {
  const resized = await sharp(sourceBuffer)
    .resize(plan.placement.width, plan.placement.height, { fit: "fill" })
    .png()
    .toBuffer();

  const image = await sharp(await transparentCanvas(plan.canvas.width, plan.canvas.height))
    .composite([{ input: resized, left: plan.placement.left, top: plan.placement.top }])
    .png()
    .toBuffer();

  // Mask: transparent everywhere (regenerate) with an opaque rectangle over
  // exactly where the original landed (keep). One pixel of overlap error here
  // is a visible seam, so the rectangle is the placement, not an inset of it.
  const keep = await opaqueCanvas(plan.placement.width, plan.placement.height);
  const mask = await sharp(await transparentCanvas(plan.canvas.width, plan.canvas.height))
    .composite([{ input: keep, left: plan.placement.left, top: plan.placement.top }])
    .png()
    .toBuffer();

  return { image, mask };
}

/* ------------------------------------------------------------------ *
 * Cutout
 * ------------------------------------------------------------------ */

async function runCutout(
  tenantId: number,
  sourceBuffer: Buffer,
  sourceMimeType: string,
): Promise<ImageOpOutcome> {
  const startedAt = Date.now();
  const ext = sourceMimeType === "image/jpeg" ? "jpg" : "png";
  const imageFile = await toFile(sourceBuffer, `source.${ext}`, { type: sourceMimeType });

  const response = await openai.images.edit({
    model: OPENAI_BUILTIN_MODEL,
    image: imageFile,
    prompt: CUTOUT_PROMPT,
    background: "transparent",
  });

  const b64 = response.data?.[0]?.b64_json ?? "";
  if (!b64) throw new ImageGenProviderError("The image provider returned no image data.");
  const buffer = Buffer.from(b64, "base64");
  const { width, height } = await dimensionsOf(buffer);

  // Trim the transparent margin so the layer's box is the subject's box. A
  // full-frame layer with a subject floating in it is technically correct and
  // useless to move around.
  let trimmed = buffer;
  let offset = { left: 0, top: 0 };
  try {
    const result = await sharp(buffer).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    trimmed = result.data;
    // sharp reports how much it removed from each edge as negative offsets.
    offset = {
      left: -(result.info.trimOffsetLeft ?? 0),
      top: -(result.info.trimOffsetTop ?? 0),
    };
  } catch {
    // A frame with no transparent margin at all makes trim throw. Keep the
    // untrimmed layer rather than failing an operation the user paid for.
    trimmed = buffer;
  }
  const trimmedSize = await dimensionsOf(trimmed);

  const objectPath = await uploadBufferToStorage(tenantId, trimmed, "image/png");
  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;

  return {
    imagePath: null,
    b64Json: null,
    width,
    height,
    sourceBox: { x: 0, y: 0, width, height },
    layers: [
      {
        objectPath,
        x: offset.left,
        y: offset.top,
        width: trimmedSize.width,
        height: trimmedSize.height,
        name: "Subject",
      },
    ],
    units: OP_UNITS.cutout,
    meta: {
      requestBytes: sourceBuffer.length,
      responseBytes: trimmed.length,
      durationMs: Date.now() - startedAt,
      model: OPENAI_BUILTIN_MODEL,
      ...(await buildImageCostMeta({
        provider: "openai",
        model: OPENAI_BUILTIN_MODEL,
        usage: usage
          ? {
              inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
              outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
            }
          : undefined,
      })),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Enlarge
 * ------------------------------------------------------------------ */

/** Hard ceiling on enlarged output, so a 4× on a large source cannot be used to burn server memory. */
const MAX_ENLARGED_PIXELS = 6000 * 6000;

/**
 * Resample the image larger.
 *
 * This is Lanczos plus a light unsharp pass — NOT AI super-resolution, and it
 * is named "Enlarge" in the UI for that reason. It invents no detail: it gets
 * you a clean 2× for a print or a retina export without the soft edges a
 * browser's default scaling gives, and it costs nothing because no provider is
 * involved. Wiring a real super-resolution model would mean a new provider
 * capability; that is a separate change, and calling this "AI upscale" in the
 * meantime would be a promise the pixels do not keep.
 */
async function runEnlarge(
  tenantId: number,
  sourceBuffer: Buffer,
  scale: number,
): Promise<ImageOpOutcome> {
  const source = await dimensionsOf(sourceBuffer);
  const factor = scale === 4 ? 4 : 2;
  const width = source.width * factor;
  const height = source.height * factor;
  if (width * height > MAX_ENLARGED_PIXELS) {
    throw new ImageOpError(
      `That would produce a ${width}×${height} image, which is larger than this tool allows. Try 2×.`,
    );
  }

  const buffer = await sharp(sourceBuffer)
    .resize(width, height, { kernel: "lanczos3", fit: "fill" })
    .sharpen({ sigma: 0.6, m1: 0.4, m2: 0.9 })
    .png()
    .toBuffer();

  const imagePath = await uploadBufferToStorage(tenantId, buffer, "image/png");
  return {
    imagePath,
    b64Json: buffer.toString("base64"),
    width,
    height,
    sourceBox: { x: 0, y: 0, width, height },
    layers: null,
    meta: null,
    units: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface RunImageOpInput {
  op: ImageOp;
  tenantId: number;
  tenant: Tenant;
  sourceBuffer: Buffer;
  sourceMimeType: string;
  /** Base64 PNG, source-sized. Transparent marks the region to regenerate. */
  maskB64?: string | null;
  prompt?: string | null;
  pad?: { left: number; right: number; top: number; bottom: number } | null;
  scale?: number | null;
}

function requireMask(input: RunImageOpInput): string {
  if (!input.maskB64) throw new ImageOpError("This operation needs a selection.");
  return input.maskB64;
}

function toOutcome(
  edit: ImageEditOutcome,
  width: number,
  height: number,
  units: number,
  sourceBox?: ImageOpBox,
): ImageOpOutcome {
  return {
    imagePath: edit.imagePath,
    b64Json: edit.b64Json,
    width,
    height,
    sourceBox: sourceBox ?? { x: 0, y: 0, width, height },
    layers: null,
    meta: edit.meta,
    units,
  };
}

export async function runImageOp(input: RunImageOpInput): Promise<ImageOpOutcome> {
  const source = await dimensionsOf(input.sourceBuffer);

  switch (input.op) {
    case "fill": {
      const prompt = (input.prompt ?? "").trim();
      if (!prompt) throw new ImageOpError("Describe what should appear in the selected area.");
      const edit = await performImageEdit({
        tenantId: input.tenantId,
        tenant: input.tenant,
        sourceBuffer: input.sourceBuffer,
        sourceMimeType: input.sourceMimeType,
        maskB64: requireMask(input),
        prompt,
      });
      return toOutcome(edit, source.width, source.height, OP_UNITS.fill);
    }

    case "remove": {
      const edit = await performImageEdit({
        tenantId: input.tenantId,
        tenant: input.tenant,
        sourceBuffer: input.sourceBuffer,
        sourceMimeType: input.sourceMimeType,
        maskB64: requireMask(input),
        prompt: REMOVE_PROMPT,
      });
      return toOutcome(edit, source.width, source.height, OP_UNITS.remove);
    }

    case "replace-background": {
      const prompt = (input.prompt ?? "").trim();
      if (!prompt) throw new ImageOpError("Describe the background you want.");
      const edit = await performImageEdit({
        tenantId: input.tenantId,
        tenant: input.tenant,
        sourceBuffer: input.sourceBuffer,
        sourceMimeType: input.sourceMimeType,
        maskB64: requireMask(input),
        prompt: `Replace the background with: ${prompt}. Keep the subject in the opaque region completely unchanged, including its edges, lighting and colour. Match the new background's light direction to the subject's.`,
      });
      return toOutcome(edit, source.width, source.height, OP_UNITS["replace-background"]);
    }

    case "expand": {
      const pad = input.pad ?? { left: 0, right: 0, top: 0, bottom: 0 };
      if (pad.left <= 0 && pad.right <= 0 && pad.top <= 0 && pad.bottom <= 0) {
        throw new ImageOpError("Choose at least one direction to expand into.");
      }
      const plan = planExpansion(source, pad);
      const { image, mask } = await buildExpandInputs(input.sourceBuffer, plan);
      const edit = await performImageEdit({
        tenantId: input.tenantId,
        tenant: input.tenant,
        sourceBuffer: image,
        sourceMimeType: "image/png",
        maskB64: mask.toString("base64"),
        prompt: EXPAND_PROMPT_PREFIX + ((input.prompt ?? "").trim() || "Keep the scene as it is."),
      });
      return toOutcome(edit, plan.canvas.width, plan.canvas.height, OP_UNITS.expand, {
        x: plan.placement.left,
        y: plan.placement.top,
        width: plan.placement.width,
        height: plan.placement.height,
      });
    }

    case "cutout":
      return runCutout(input.tenantId, input.sourceBuffer, input.sourceMimeType);

    case "enlarge":
      return runEnlarge(input.tenantId, input.sourceBuffer, input.scale ?? 2);

    default:
      throw new ImageOpError("Unknown operation.");
  }
}
