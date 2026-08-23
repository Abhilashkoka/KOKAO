import { usageAccountingParams } from "../../aiCost";
import { logger } from "../../logger";
import { getGovernedPrompt, logCompiledPrompt } from "../../promptKit";
import { getTextGenClient } from "../../textGen";

/**
 * Best-effort cinematic polish shared by prompt-video shots and topic-video
 * scenes. The planned meaning and continuity choices stay fixed; only the
 * generation language is sharpened before an image or video provider sees it.
 */
export async function refineScenePrompts(params: {
  tenantAiModel: string;
  prompts: string[];
  /** Enables Prompt Template Kit governance when the tenant is known. */
  tenantId?: number | null;
}): Promise<string[]> {
  const originals = params.prompts;
  if (originals.length === 0) return originals;

  try {
    const textGen = await getTextGenClient(params.tenantAiModel);
    const governed = params.tenantId
      ? await getGovernedPrompt({
          flowKey: "video_scene_image",
          tenantId: params.tenantId,
          clerkUserId: "",
          customizationId: null,
          runtimeContext:
            `Task: rewrite ${originals.length} planned scene description(s) into final ` +
            "AI image/video generation prompts without changing their meaning, order, " +
            "subjects, wardrobe, settings, or existing continuity choices.",
          outputFormat:
            `Respond with ONLY a JSON object of this exact shape: ` +
            `{"prompts": ["...", "..."]} with exactly ${originals.length} strings.`,
          placeholderValues: {
            topic: originals.join("\n"),
            sceneCount: String(originals.length),
          },
        })
      : null;
    const sceneList = originals
      .map((prompt, i) => `${i + 1}. ${prompt.slice(0, 1000)}`)
      .join("\n");
    const startedAt = Date.now();
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        {
          role: "system",
          content: governed
            ? governed.text
            : "You are a cinematic prompt writer for AI image and video generation. You reply with strict JSON only.",
        },
        {
          role: "user",
          content:
            `These ${originals.length} planned scene description(s) will each drive one AI-generated visual, in order:\n\n${sceneList}\n\n` +
            "Rewrite each into one polished, cinematic generation prompt. Preserve the original subject, action, setting, wardrobe, props, shared-look clauses, and continuity choices exactly; do not unify scenes whose subjects or settings deliberately differ. Keep the sequence visually varied: do not introduce a repeated subject/activity, setting, framing, or camera move in adjacent scenes, and retain each planned scene's distinct visual angle. Sharpen each prompt with concrete craft: framing and lens feel, one slow camera move, quality and direction of light, atmosphere, and tactile texture (dust in sunlight, water reflections, surface detail). Aim for premium commercial film language that is specific and sensory rather than generic adjectives. " +
            "Do not add characters, costume changes, brands, dialogue, on-screen text, camera-cut instructions, or watermarks.\n\n" +
            `Reply as {"prompts": ["...", "..."]} with exactly ${originals.length} strings, in the same order.`,
        },
      ],
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });

    if (governed && params.tenantId) {
      try {
        await logCompiledPrompt({
          tenantId: params.tenantId,
          flowKey: "video_scene_image",
          governed,
          generationContext: {
            model: textGen.model,
            sceneCount: originals.length,
            stage: "cinematic_refinement",
          },
          success: true,
          latencyMs: Date.now() - startedAt,
          tokenUsage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens ?? 0,
                completionTokens: completion.usage.completion_tokens ?? 0,
                totalTokens: completion.usage.total_tokens ?? 0,
              }
            : null,
        });
      } catch (error) {
        logger.warn({ err: error }, "Compiled prompt logging failed; continuing");
      }
    }

    const parsed: unknown = JSON.parse(completion.choices[0]?.message?.content ?? "");
    const prompts = (parsed as { prompts?: unknown }).prompts;
    if (!Array.isArray(prompts)) return originals;
    const cleaned = prompts.map((prompt) =>
      typeof prompt === "string" ? prompt.trim().slice(0, 2000) : "",
    );
    return originals.map((original, i) => cleaned[i] || original);
  } catch (error) {
    logger.warn(
      { err: error, tenantId: params.tenantId ?? null },
      "Scene prompt polish failed; using the planned prompts as-is",
    );
    return originals;
  }
}