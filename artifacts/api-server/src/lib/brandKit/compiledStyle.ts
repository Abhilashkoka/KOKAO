import { db, brandKitVersionsTable, type BrandKitPayload } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { enqueueBackgroundJob } from "../backgroundJobs";
import { getTextGenClient } from "../textGen";
import { DEFAULT_AI_MODEL } from "../aiModels";
import { describeBrandForDesign } from "../designSkill";
import { logger } from "../logger";

/**
 * Precompiled brand style prompts.
 *
 * The per-image "design skill" pass costs a full text-model round trip on
 * EVERY image generation. Because brand kit versions are immutable (an edit
 * creates a new version), the brand-derived part of that art direction can be
 * compiled ONCE per version, in the background, right after the version is
 * created. Image generation then combines the user's brief with the stored
 * text and skips the inline design pass entirely.
 *
 * Everything here fails soft: a compile failure just leaves the column null
 * and image generation falls back to the inline design pass as before.
 */

const COMPILE_SYSTEM_PROMPT = [
  "You are a senior brand art director. Given a brand's visual identity, write a single reusable ART DIRECTION paragraph that can be appended to ANY image-generation brief for this brand.",
  "The paragraph must cover: color palette usage (name the exact hex values), lighting and mood, composition preferences, imagery/illustration style, and the overall aesthetic personality.",
  "Rules: be specific and directive (\"use X\", \"favor Y\"), no markdown, no lists, no preamble, 60-160 words, do not mention any concrete subject matter — it must work for any brief.",
].join(" ");

/** One LLM pass turning brand elements into a reusable style directive. */
export async function compileBrandStylePrompt(
  brand: BrandKitPayload,
): Promise<string | null> {
  const textGen = await getTextGenClient(DEFAULT_AI_MODEL);
  const completion = await textGen.client.chat.completions.create({
    model: textGen.model,
    messages: [
      { role: "system", content: COMPILE_SYSTEM_PROMPT },
      { role: "user", content: `Brand elements: ${describeBrandForDesign(brand)}` },
    ],
    max_completion_tokens: 1024,
  });
  const text = completion.choices[0]?.message?.content?.trim() ?? "";
  return text.length >= 20 ? text : null;
}

/**
 * Fire-and-forget: compile and store the style prompt for one version.
 * Only fills the column when it is still null (versions are immutable, so a
 * second run has nothing better to say). Never throws.
 */
export function scheduleStyleCompile(
  tenantId: number,
  versionId: number,
  payload: BrandKitPayload,
): void {
  enqueueBackgroundJob(async () => {
    try {
      const compiled = await compileBrandStylePrompt(payload);
      if (!compiled) return;
      await db
        .update(brandKitVersionsTable)
        .set({ compiledStylePrompt: compiled })
        .where(
          and(
            eq(brandKitVersionsTable.id, versionId),
            eq(brandKitVersionsTable.tenantId, tenantId),
            isNull(brandKitVersionsTable.compiledStylePrompt),
          ),
        );
    } catch (err) {
      logger.error({ err, versionId }, "Brand style compile failed (fails soft)");
    }
  });
}
