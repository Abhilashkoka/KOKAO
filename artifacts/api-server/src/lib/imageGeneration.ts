import type { Tenant, BrandKitPayload } from "@workspace/db";
import { generateImage } from "./imageGen";
import type { ReferenceImage, ImageSize } from "./imageGen";
import { ObjectStorageService } from "./objectStorage";
import { loadActivePayload } from "./brandKit/service";
import { isDesignSkillEnabledFor, buildDesignedImagePrompt } from "./designSkill";
import { buildReferenceGuide } from "./referenceGuide";
import { isFeatureEnabled } from "./featureFlags";
import { applyMadeWithWatermark } from "./watermark";
import { getTextGenClient } from "./textGen";
import { buildTasteGuidance } from "./tasteMemory";
import { buildImageCostMeta } from "./aiCost";
import type { UsageMeta } from "./usage";
import { logger } from "./logger";

/**
 * The full image-generation pipeline shared by the synchronous
 * POST /ai/generate-image route and the background image-job runner:
 * prompt assembly (brand hints, taste memory, design skill or the
 * precompiled brand style, reference guide) -> provider call -> optional
 * free-plan watermark -> upload to tenant-scoped storage.
 *
 * Latency design: the three pre-image text passes (taste guidance, design
 * skill, reference guide) are independent of each other, so they run in
 * PARALLEL. Assembly order is unchanged from the old serial flow: design
 * output (or base prompt + taste hint) first, reference guide appended last
 * so it survives prompt rewriting. When the brand kit version carries a
 * precompiled style prompt, the design pass is skipped entirely.
 *
 * Funding is NOT handled here — callers reserve before and settle/release
 * after, exactly as before.
 */

const objectStorageService = new ObjectStorageService();

export interface ImageGenerationInput {
  tenantId: number;
  tenant: Tenant;
  /** The user's raw brief (may already include a tweak suffix). */
  userPrompt: string;
  size: ImageSize;
  brandKitId: number | null;
  referenceImage?: ReferenceImage | null;
}

export interface ImageGenerationOutcome {
  imagePath: string;
  b64Json: string;
  /** Usage metadata for settleFunding (funding key added by the caller). */
  meta: Omit<UsageMeta, "funding">;
}

/** Flatten every brand color into a short, comma-joined hint for prompts. */
function colorHint(payload: BrandKitPayload): string {
  const colors = [
    ...payload.colors.primary,
    ...payload.colors.secondary,
    ...payload.colors.neutral,
  ]
    .map((c) => c.hex)
    .filter(Boolean)
    .slice(0, 6);
  return colors.join(", ");
}

/** A concise voice descriptor from the brand payload for prompt injection. */
function brandVoiceHint(payload: BrandKitPayload): string {
  const traits = payload.voice.traits.filter(Boolean).slice(0, 5);
  if (traits.length > 0) return traits.join(", ");
  return payload.voice.caption_style || "modern";
}

/** Assemble the final image prompt, running the text-model passes in parallel. */
export async function buildImagePrompt(input: {
  tenantId: number;
  tenant: Tenant;
  userPrompt: string;
  brandKitId: number | null;
  referenceImage?: ReferenceImage | null;
}): Promise<string> {
  const { tenantId, tenant, userPrompt, brandKitId, referenceImage } = input;

  const resolved = await loadActivePayload(tenantId, brandKitId);
  const brand = resolved?.payload ?? null;
  const compiledStyle = resolved?.compiledStylePrompt ?? null;

  // Base prompt (also the fallback if the design skill is off or fails):
  // the user's brief plus lightweight brand hints.
  let base = userPrompt;
  if (brand) {
    const palette = colorHint(brand);
    const imagery = brand.visual_style.imagery_style.slice(0, 3).join(", ");
    if (palette) base += `. Brand palette: ${palette}.`;
    if (imagery) base += ` Imagery style: ${imagery}.`;
    base += ` Cohesive with a ${brandVoiceHint(brand)} brand aesthetic.`;
  }

  // Text-model passes fail soft: if the routed text-gen provider is
  // unconfigured, image generation continues with the base prompt.
  const softTextGen = await getTextGenClient(tenant.aiModel).catch(() => null);

  // The design pass is skipped when a precompiled brand style exists for
  // this brand kit version — the compiled text carries the art direction.
  const wantDesignPass =
    !compiledStyle && !!softTextGen && (await isDesignSkillEnabledFor(tenant));

  const [taste, designed, guide] = await Promise.all([
    buildTasteGuidance(tenantId).catch(() => ({ captionLines: [], imageHint: null })),
    wantDesignPass && softTextGen
      ? buildDesignedImagePrompt({
          client: softTextGen.client,
          model: softTextGen.model,
          userPrompt,
          brand,
          // Empty fallback: fallback assembly (base + taste hint) happens
          // below because the taste pass runs concurrently with this one.
          fallbackPrompt: "",
        })
      : Promise.resolve(null),
    referenceImage && softTextGen
      ? buildReferenceGuide({
          client: softTextGen.client,
          model: softTextGen.model,
          image: referenceImage,
        })
      : Promise.resolve(null),
  ]);

  let prompt: string;
  if (designed?.enriched) {
    // Same as the old flow: the art-directed prompt replaces the base
    // prompt (and its taste hint) entirely.
    logger.info(
      { philosophy: designed.philosophy },
      "Design skill enriched image prompt",
    );
    prompt = designed.imagePrompt;
  } else {
    prompt = base;
    if (compiledStyle) prompt += ` Art direction: ${compiledStyle}`;
    if (taste.imageHint) prompt += taste.imageHint;
  }

  // Reference guide: appended AFTER everything else so it always survives
  // prompt rewriting.
  if (referenceImage) {
    prompt += guide
      ? ` Match the style of the user's reference image: ${guide}`
      : " Match the overall style, palette, and mood of the user's reference image.";
  }

  return prompt;
}

/** Run the pipeline end-to-end. Throws provider/upload errors to the caller. */
export async function performImageGeneration(
  input: ImageGenerationInput,
): Promise<ImageGenerationOutcome> {
  const startedAt = Date.now();
  const prompt = await buildImagePrompt(input);

  const {
    buffer: rawBuffer,
    model: imageModel,
    provider: imageProvider,
    usage: imageUsage,
  } = await generateImage(prompt, input.size, input.referenceImage ?? undefined);

  // Free-plan workspaces get a "Made with KOKAO.in" stamp, platform-wide
  // switch "freeWatermark" (default-ON: a transient flag-read error fails
  // OPEN); compositing errors fail soft to the original image.
  const wantWatermark =
    input.tenant.plan === "free" &&
    (await isFeatureEnabled("freeWatermark").catch(() => true));
  const buffer = wantWatermark ? await applyMadeWithWatermark(rawBuffer) : rawBuffer;

  const uploadURL = await objectStorageService.getObjectEntityUploadURL(input.tenantId);
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(30_000),
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed with status ${putRes.status}`);
  }
  const imagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);

  const b64Json = buffer.toString("base64");
  return {
    imagePath,
    b64Json,
    meta: {
      requestBytes: Buffer.byteLength(prompt),
      responseBytes: buffer.length + Buffer.byteLength(b64Json),
      durationMs: Date.now() - startedAt,
      model: imageModel,
      ...(await buildImageCostMeta({
        provider: imageProvider,
        model: imageModel,
        usage: imageUsage,
      })),
    },
  };
}
