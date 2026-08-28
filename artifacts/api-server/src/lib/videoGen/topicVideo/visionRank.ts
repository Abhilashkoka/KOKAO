import { getTextGenClient } from "../../textGen";
import { usageAccountingParams } from "../../aiCost";
import { logger } from "../../logger";
import { withTimeout } from "../retry";
import type { StockClip } from "./stockSources";

/**
 * Vision-based relevance ranking for stock footage.
 *
 * Keyword search alone routinely returns footage that matches the words but
 * not the meaning (worse still for non-English topics, whose search terms
 * are translated). This pass shows the candidates' thumbnail frames to the
 * tenant's vision-capable text model in ONE call and asks it to assign the
 * best-matching candidate to every scene of the script.
 *
 * Strictly fail-soft: any error, timeout, non-vision model, or malformed
 * reply returns null and the caller falls back to the existing round-robin
 * behavior. A ranking pass must never fail a video that would otherwise
 * render.
 */

/** Most thumbnails one call carries; keeps vision payloads and cost sane. */
export const MAX_RANKED_CANDIDATES = 12;

/** One vision call, bounded — ranking is an enhancement, not a dependency. */
const RANK_TIMEOUT_MS = 60_000;

export interface SceneAssignment {
  /** Per scene (same order as `sceneTexts`): index into the candidate list. */
  sceneToCandidate: number[];
}

export async function assignClipsToScenes(params: {
  tenantAiModel: string;
  topic: string;
  sceneTexts: string[];
  candidates: StockClip[];
}): Promise<SceneAssignment | null> {
  const withThumbs = params.candidates
    .map((clip, index) => ({ clip, index }))
    .filter((c) => !!c.clip.thumbnailUrl)
    .slice(0, MAX_RANKED_CANDIDATES);
  // Ranking needs real choices; with 0-1 usable thumbnails there is nothing
  // to decide.
  if (withThumbs.length < 2 || params.sceneTexts.length === 0) return null;

  try {
    const textGen = await getTextGenClient(params.tenantAiModel, {
      capability: "multimodal",
    });
    const sceneList = params.sceneTexts.map((text, i) => `${i + 1}. ${text}`).join("\n");
    const content: (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    )[] = [
      {
        type: "text",
        text: `# Role: Video Editor picking b-roll

A short video about "${params.topic}" has ${params.sceneTexts.length} narrated scenes. Below are ${withThumbs.length} candidate stock clips (one thumbnail each, numbered in order).

## Scenes (narration):
${sceneList}

## Rules:
1. Reply with strict JSON only: {"assignments": [<candidate number for scene 1>, <for scene 2>, ...]} — exactly ${params.sceneTexts.length} numbers, each between 1 and ${withThumbs.length}.
2. Pick the candidate whose FOOTAGE best matches each scene's meaning — not just its keywords.
3. Prefer visual variety: avoid reusing a candidate while an unused one fits reasonably well.
4. Never pick a thumbnail with visible watermarks, text overlays, or people looking straight into the camera awkwardly.`,
      },
      ...withThumbs.map((c) => ({
        type: "image_url" as const,
        image_url: { url: c.clip.thumbnailUrl! },
      })),
    ];

    const completion = await withTimeout(
      () =>
        textGen.client.chat.completions.create({
          model: textGen.model,
          messages: [
            {
              role: "system",
              content: "You match stock footage to video scenes and reply with strict JSON only.",
            },
            { role: "user", content },
          ],
          max_completion_tokens: 2048,
          response_format: { type: "json_object" },
          ...usageAccountingParams(textGen.provider),
        }),
      RANK_TIMEOUT_MS,
      "Footage ranking",
    );

    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "") as {
      assignments?: unknown;
    };
    const assignments: unknown[] | null = Array.isArray(parsed.assignments)
      ? parsed.assignments
      : null;
    if (!assignments) return null;
    const sceneToCandidate = params.sceneTexts.map((_, i) => {
      const pick = assignments[i];
      const number = typeof pick === "number" ? Math.trunc(pick) : NaN;
      // Model numbers are 1-based positions in the thumbnail list; map back
      // to the caller's candidate indices. Bad entries fall back per scene.
      if (number >= 1 && number <= withThumbs.length) {
        return withThumbs[number - 1]!.index;
      }
      return withThumbs[i % withThumbs.length]!.index;
    });
    return { sceneToCandidate };
  } catch (error) {
    logger.warn({ err: error }, "Vision footage ranking failed; using search order");
    return null;
  }
}
