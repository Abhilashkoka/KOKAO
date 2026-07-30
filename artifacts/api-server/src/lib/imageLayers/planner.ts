import type { Tenant, BrandKitPayload } from "@workspace/db";
import { getTextGenClient } from "../textGen";
import { loadActivePayload } from "../brandKit/service";
import { describeBrandForDesign } from "../designSkill";
import { logger } from "../logger";
import type { ImageSize } from "../imageGen";
import {
  MAX_PLANNED_LAYERS,
  canvasFor,
  normalizeLayerPlan,
  type LayerPlan,
} from "./types";

/**
 * Turns a brief into a layer plan using the TEXT model, not an image model.
 *
 * This is what makes the opt-in credit quote honest: planning costs a
 * fractions-of-a-paisa chat completion, so the app can tell the user "this
 * will be six layers, six credits" BEFORE anything bills them for pixels.
 *
 * The planner never sees the word "transparent" in its output contract. Alpha
 * is a render flag; a model told to describe transparency tends to draw a
 * checkerboard.
 */

export class LayerPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerPlanError";
  }
}

function systemPrompt(width: number, height: number): string {
  return [
    "You decompose an image brief into an ordered stack of independently renderable layers.",
    `The canvas is ${width}x${height} pixels. Origin is top-left.`,
    "",
    "Return ONLY JSON of the form:",
    '{"styleDna": string, "layers": [{"id": string, "role": "background"|"object"|"shadow", "z": number, "bbox": [x1,y1,x2,y2], "prompt": string}]}',
    "",
    "Rules:",
    `1. Produce between 2 and ${MAX_PLANNED_LAYERS} layers. Merge minor elements rather than exceeding the cap; every layer costs the user one image credit.`,
    "2. Exactly one layer has role \"background\": a single unobstructed backdrop plane covering the whole canvas. Never describe it as 'the scene without the subject'.",
    "3. styleDna is subject-agnostic: medium, lens, light direction and quality, colour temperature, palette, grain. It must contain NO nouns from the subject matter, because it is copied verbatim into every layer prompt.",
    "4. Each layer prompt describes ONE element, alone, complete and uncropped, as if photographed by itself. Describe the element even where the composition would hide part of it — a layer the user moves must not reveal a missing edge.",
    "5. Never write the words layer, PSD, transparent, isolated, cutout or white background inside a layer prompt.",
    "6. Any element that blocks light onto the surface below gets a paired layer with role \"shadow\": greyscale, soft-edged, described as a shadow shape only. Its bbox sits under the object it belongs to. Never let a shadow be part of the object's own prompt.",
    "7. bbox places the element in the composition and must not crop it. Shadows and objects use real boxes; the background box is ignored.",
    "8. z ascends in the paint order you want, background lowest.",
  ].join("\n");
}

function brandBlock(brand: BrandKitPayload | null): string {
  if (!brand) {
    return "No brand kit is available; choose a palette and aesthetic that best serve the brief.";
  }
  return `This image is for a specific brand. Build styleDna's palette and aesthetic from these brand elements (mandatory): ${describeBrandForDesign(brand)}`;
}

export async function planImageLayers(input: {
  tenantId: number;
  tenant: Tenant;
  /** The user's raw brief. */
  brief: string;
  size: ImageSize;
  brandKitId: number | null;
}): Promise<LayerPlan> {
  const { width, height } = canvasFor(input.size);

  // Unlike the design-skill pass, this one fails LOUDLY. A soft failure would
  // mean silently generating a flat image after the user chose (and was
  // quoted for) a layered one.
  const textGen = await getTextGenClient(input.tenant.aiModel).catch((err) => {
    logger.error({ err }, "Layer planner could not resolve a text-gen client");
    return null;
  });
  if (!textGen) {
    throw new LayerPlanError(
      "Layer planning needs a configured text model. Ask your admin to check the text generation provider.",
    );
  }

  const brand = (await loadActivePayload(input.tenantId, input.brandKitId).catch(() => null))
    ?.payload ?? null;

  let raw: string;
  try {
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        { role: "system", content: systemPrompt(width, height) },
        { role: "user", content: `Image brief: ${input.brief}\n\n${brandBlock(brand)}` },
      ],
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
    });
    raw = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    logger.error({ err }, "Layer planner call failed");
    throw new LayerPlanError("Could not plan the layers for this image. Please try again.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LayerPlanError("Could not plan the layers for this image. Please try again.");
  }

  const plan = normalizeLayerPlan(parsed, input.size);
  if (!plan) {
    throw new LayerPlanError(
      "This brief did not split into separate elements. Generate it as a flat image instead.",
    );
  }
  return plan;
}

/**
 * The per-layer image prompt. styleDna leads so the look is established before
 * the subject, and the exclusion block is appended verbatim to every layer —
 * most notably "no cast shadow", because a baked-in shadow is what makes a
 * composited layer unusable the moment it is moved.
 */
export function layerImagePrompt(plan: LayerPlan, layerIndex: number): string {
  const layer = plan.layers[layerIndex];
  if (layer.role === "background") {
    return [
      plan.styleDna,
      `Backdrop: ${layer.prompt}`,
      "Fills the entire frame evenly. No products, no people, no text, no props, no border or frame.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (layer.role === "shadow") {
    return [
      `Subject: ${layer.prompt}`,
      "A soft greyscale shadow shape on a plain white field. Feathered edges, no object, no outline, no text, nothing else in frame.",
    ].join("\n\n");
  }
  return [
    plan.styleDna,
    `Subject: ${layer.prompt}`,
    "The subject alone, centred, complete, nothing cropped at any edge.",
    "Exclude: cast shadow, drop shadow, reflection, ground plane, table, floor, horizon, a second object, background scenery, border, frame, watermark, text, collage, grid, multiple views.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
