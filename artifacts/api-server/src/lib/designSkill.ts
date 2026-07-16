import {
  db,
  designSkillSettingsTable,
  type Tenant,
  type BrandKitPayload,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { CANVAS_DESIGN_SKILL } from "../skills/canvasDesign";
import { logger } from "./logger";

/**
 * The canvas-design prompt skill: a two-step "design philosophy first" prompt
 * enrichment applied to every image generation when enabled.
 *
 * Resolution order for whether it runs:
 *   1. Per-tenant override (`tenants.designSkillEnabled`) when not null
 *   2. Global superadmin switch (`design_skill_settings.enabled`)
 *   3. Default: enabled
 */

/** Load the singleton settings row (undefined when never configured). */
export async function loadDesignSkillRow() {
  return (await db.select().from(designSkillSettingsTable).limit(1))[0];
}

/** The effective global switch (defaults to enabled when never configured). */
export async function getGlobalDesignSkillEnabled(): Promise<boolean> {
  const row = await loadDesignSkillRow();
  return row ? row.enabled : true;
}

/** Whether the skill should run for this tenant's image generations. */
export async function isDesignSkillEnabledFor(tenant: Tenant): Promise<boolean> {
  if (tenant.designSkillEnabled !== null && tenant.designSkillEnabled !== undefined) {
    return tenant.designSkillEnabled;
  }
  return getGlobalDesignSkillEnabled();
}

/** Compact, prompt-ready description of the brand kit's visual elements. */
export function describeBrandForDesign(brand: BrandKitPayload): string {
  const parts: string[] = [];
  parts.push(`Brand name: ${brand.identity.brand_name}.`);
  if (brand.identity.tagline) parts.push(`Tagline: ${brand.identity.tagline}.`);

  const colors = [
    ...brand.colors.primary.map((c) => `${c.hex}${c.name ? ` (${c.name})` : ""}`),
    ...brand.colors.secondary.map((c) => c.hex),
    ...brand.colors.neutral.map((c) => c.hex),
  ]
    .filter(Boolean)
    .slice(0, 8);
  if (colors.length > 0) parts.push(`Brand colors: ${colors.join(", ")}.`);

  const fonts = [brand.typography.heading_font, brand.typography.body_font]
    .filter(Boolean)
    .join(", ");
  if (fonts) parts.push(`Typography: ${fonts}.`);

  const imagery = brand.visual_style.imagery_style.filter(Boolean).slice(0, 4);
  if (imagery.length > 0) parts.push(`Imagery style: ${imagery.join(", ")}.`);

  const illustration = brand.visual_style.illustration_style;
  if (illustration) parts.push(`Illustration style: ${illustration}.`);

  const traits = brand.voice.traits.filter(Boolean).slice(0, 5);
  if (traits.length > 0) parts.push(`Brand personality: ${traits.join(", ")}.`);

  return parts.join(" ");
}

export interface DesignPromptResult {
  /** The final prompt to send to the image model. */
  imagePrompt: string;
  /** Short philosophy summary (returned for transparency/logging). */
  philosophy: string | null;
  /** Whether enrichment actually ran (false = fell back to the base prompt). */
  enriched: boolean;
}

/**
 * Run the canvas-design skill: ask the text model for a design philosophy and
 * a compiled image prompt. Brand elements are mandatory input when a brand kit
 * is available. Fails soft: any error falls back to the caller's base prompt.
 */
export async function buildDesignedImagePrompt(options: {
  model: string;
  userPrompt: string;
  brand: BrandKitPayload | null;
  fallbackPrompt: string;
}): Promise<DesignPromptResult> {
  const { model, userPrompt, brand, fallbackPrompt } = options;

  const userParts: string[] = [`Image brief: ${userPrompt}`];
  if (brand) {
    userParts.push(
      `This image is for a specific brand. Build the palette and aesthetic from these brand elements (mandatory): ${describeBrandForDesign(brand)}`,
    );
  } else {
    userParts.push(
      "No brand kit is available; choose a palette and aesthetic that best serve the brief.",
    );
  }

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: CANVAS_DESIGN_SKILL },
        { role: "user", content: userParts.join("\n\n") },
      ],
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const obj = JSON.parse(raw) as { philosophy?: unknown; imagePrompt?: unknown };
    const imagePrompt =
      typeof obj.imagePrompt === "string" ? obj.imagePrompt.trim() : "";
    if (!imagePrompt) throw new Error("Design skill returned no imagePrompt");

    return {
      imagePrompt,
      philosophy: typeof obj.philosophy === "string" ? obj.philosophy : null,
      enriched: true,
    };
  } catch (err) {
    logger.error({ err }, "Design skill prompt enrichment failed; using base prompt");
    return { imagePrompt: fallbackPrompt, philosophy: null, enriched: false };
  }
}
