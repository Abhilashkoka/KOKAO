import sharp from "sharp";
import type { Tenant } from "@workspace/db";
import { generateImage, type ImageSize } from "../imageGen";
import { uploadBufferToStorage } from "../storageUpload";
import { buildImageCostMeta } from "../aiCost";
import { applyMadeWithWatermark } from "../watermark";
import { getPlan } from "../plans";
import { isFeatureEnabled } from "../featureFlags";
import type { UsageMeta } from "../usage";
import { logger } from "../logger";
import { layerImagePrompt } from "./planner";
import { canvasFor, type LayerPlan, type PlannedLayer } from "./types";

/**
 * Renders a layer plan into (a) one transparent PNG per element and (b) a
 * flattened composite.
 *
 * Both outputs matter. The composite is what every existing consumer already
 * understands — the library card, the publish pipeline, the download — so
 * layered generation adds a capability without asking any of them to change.
 * The per-layer PNGs are what the editor moves around.
 *
 * Layers render SEQUENTIALLY rather than in parallel. Each call goes through
 * the provider router's circuit breaker, and firing eight at once would
 * either trip a rate limit mid-plan (leaving a half-paid job) or race the
 * breaker's health accounting. A layered image is a background job precisely
 * so it is allowed to take a minute.
 */

/** The editor's element-layer shape (mirrors socialforge image-editor.tsx). */
interface DocElementLayer {
  id: string;
  type: "image";
  objectPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Optional, additive: understood by the editor, ignored by older clients. */
  opacity?: number;
  blend?: "normal" | "multiply";
  name?: string;
}

export interface LayerDocument {
  version: 1;
  basePath: string;
  layers: DocElementLayer[];
}

export interface LayeredRenderOutcome {
  /** Flattened composite; what `image_generations.imagePath` gets. */
  imagePath: string;
  b64Json: string;
  layerDoc: LayerDocument;
  meta: Omit<UsageMeta, "funding">;
}

/** Nearest provider-supported canvas for a box, by aspect ratio. */
function sizeForBox(width: number, height: number): ImageSize {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.25) return "1536x1024";
  if (ratio < 0.8) return "1024x1536";
  return "1024x1024";
}

/**
 * Trim the transparent margin a generator leaves around an isolated subject,
 * then fit it inside its planned box without distorting it.
 *
 * Without the trim the "subject" is a 1024px square that happens to contain a
 * cup, so placing it in a 400px box makes the cup tiny and the user's first
 * action in the editor is to fix our arithmetic.
 */
async function fitToBox(
  buffer: Buffer,
  box: [number, number, number, number],
): Promise<{ buffer: Buffer; x: number; y: number; width: number; height: number }> {
  const [x1, y1, x2, y2] = box;
  const boxW = Math.max(1, x2 - x1);
  const boxH = Math.max(1, y2 - y1);

  let trimmed = buffer;
  try {
    // A fully uniform image makes sharp's trim throw; that is a legitimate
    // outcome (an empty layer), so fall back to the untrimmed buffer.
    trimmed = await sharp(buffer).trim({ threshold: 1 }).png().toBuffer();
  } catch {
    trimmed = buffer;
  }

  const resized = await sharp(trimmed)
    .resize(boxW, boxH, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const width = meta.width ?? boxW;
  const height = meta.height ?? boxH;
  return {
    buffer: resized,
    // Centre inside the planned box: "inside" preserves aspect, so one axis
    // is short and centring is the only placement that cannot look accidental.
    x: Math.round(x1 + (boxW - width) / 2),
    y: Math.round(y1 + (boxH - height) / 2),
    width,
    height,
  };
}

interface RenderedLayer {
  planned: PlannedLayer;
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function renderLayeredImage(input: {
  tenantId: number;
  tenant: Tenant;
  plan: LayerPlan;
  size: ImageSize;
  /** Called before each layer so the job row can show real progress. */
  onProgress?: (stage: string) => Promise<void> | void;
}): Promise<LayeredRenderOutcome> {
  const { width: canvasW, height: canvasH } = canvasFor(input.size);
  const startedAt = Date.now();
  const total = input.plan.layers.length;

  let costPaise = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let anyCost = false;
  let provider = "";
  let model = "";
  let fallbackStep = 0;
  let responseBytes = 0;

  let background: Buffer | null = null;
  const rendered: RenderedLayer[] = [];

  for (let i = 0; i < total; i += 1) {
    const planned = input.plan.layers[i];
    await input.onProgress?.(`Rendering layer ${i + 1} of ${total}: ${planned.id}`);

    const isBackground = planned.role === "background";
    const [x1, y1, x2, y2] = planned.bbox;
    const result = await generateImage(
      layerImagePrompt(input.plan, i),
      isBackground ? input.size : sizeForBox(x2 - x1, y2 - y1),
      undefined,
      // Shadows render as greyscale on white and composite with multiply, so
      // they need no alpha — which also keeps them off the transparency-capable
      // provider filter and out of its rate limit.
      { transparent: planned.role === "object" },
    );

    provider = result.provider;
    model = result.model;
    fallbackStep = Math.max(fallbackStep, result.fallbackStep);
    responseBytes += result.buffer.length;

    const cost = await buildImageCostMeta({
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    });
    if (cost.costPaise !== undefined) {
      costPaise += cost.costPaise;
      anyCost = true;
    }
    inputTokens += cost.inputTokens ?? 0;
    outputTokens += cost.outputTokens ?? 0;

    if (isBackground) {
      background = await sharp(result.buffer)
        .resize(canvasW, canvasH, { fit: "cover" })
        .png()
        .toBuffer();
      continue;
    }
    const fitted = await fitToBox(result.buffer, planned.bbox);
    rendered.push({ planned, ...fitted });
  }

  if (!background) {
    // normalizeLayerPlan guarantees a background, so reaching here means the
    // plan was mutated between validation and render.
    throw new Error("Layer plan produced no background layer");
  }

  // Flatten. Element order is the plan's z order, which `rendered` preserves.
  const flatRaw = await sharp(background)
    .composite(
      rendered.map((r) => ({
        input: r.buffer,
        left: Math.max(0, Math.min(canvasW - 1, r.x)),
        top: Math.max(0, Math.min(canvasH - 1, r.y)),
        blend: r.planned.role === "shadow" ? ("multiply" as const) : ("over" as const),
      })),
    )
    .png()
    .toBuffer();

  const wantWatermark =
    (await getPlan(input.tenant.plan).catch(() => null))?.watermark === true &&
    (await isFeatureEnabled("freeWatermark").catch(() => true));
  const flat = wantWatermark ? await applyMadeWithWatermark(flatRaw) : flatRaw;

  // Uploads are independent of each other, unlike the generations.
  const [basePath, flatPath, ...layerPaths] = await Promise.all([
    uploadBufferToStorage(input.tenantId, background, "image/png"),
    uploadBufferToStorage(input.tenantId, flat, "image/png"),
    ...rendered.map((r) => uploadBufferToStorage(input.tenantId, r.buffer, "image/png")),
  ]);

  const layerDoc: LayerDocument = {
    version: 1,
    // The editor resumes on the base image and re-stacks the elements, so the
    // flattened composite is never edited twice.
    basePath,
    layers: rendered.map((r, i) => ({
      id: r.planned.id,
      type: "image" as const,
      objectPath: layerPaths[i],
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      ...(r.planned.role === "shadow"
        ? { blend: "multiply" as const, opacity: 0.85 }
        : {}),
      name: r.planned.id.replace(/_/g, " "),
    })),
  };

  logger.info(
    { tenantId: input.tenantId, layers: total, provider, model },
    "Layered image rendered",
  );

  return {
    imagePath: flatPath,
    b64Json: flat.toString("base64"),
    layerDoc,
    meta: {
      requestBytes: Buffer.byteLength(JSON.stringify(input.plan)),
      responseBytes,
      durationMs: Date.now() - startedAt,
      model,
      provider,
      fallbackStep,
      routingReason: `layered generation: ${total} renders`,
      ...(anyCost ? { costPaise } : {}),
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
    },
  };
}
