import type { PromptVariantKey, VideoTemplateRuntimeSettings } from "@workspace/db";
import { getTextGenClient } from "../../textGen";
import { usageAccountingParams } from "../../aiCost";
import { VideoGenProviderError } from "../types";
import { getGovernedPrompt, logCompiledPrompt } from "../../promptKit";

/**
 * Script + stock-search-term generation for the Topic to Video engine.
 *
 * Prompt rules are ported from MoneyPrinterTurbo (MIT, app/services/llm.py) —
 * its script generator and search-term generator, merged into one JSON call so
 * a topic costs a single completion. The narration rules ("no markdown, get
 * straight to the point, same language as the topic") come straight from its
 * battle-tested defaults; search terms stay English-only because Pexels and
 * Pixabay index English tags.
 */

export interface TopicScript {
  /** The narration script, plain spoken text. */
  script: string;
  /** English stock-footage search terms, ordered to follow the script. */
  searchTerms: string[];
  /** Non-spoken claim markers retained for rendering/review gates. */
  verificationFindings: string[];
}

/** Bounded by the text-model output envelope and the runtime scene cap. */
export const MAX_PARAGRAPHS = 20;

export function buildTopicScriptPrompt(
  topic: string,
  paragraphCount: number,
  brandVoice?: string | null,
  referenceStyle?: string | null,
  runtime?: VideoTemplateRuntimeSettings | null,
): string {
  const legacyParagraphs = Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
  const detailShare =
    runtime?.scriptDetailLevel === "concise"
      ? 0.65
      : runtime?.scriptDetailLevel === "detailed"
        ? 0.95
        : 0.8;
  const targetWords = runtime
    ? Math.max(
        20,
        Math.floor((runtime.maxDurationSeconds * runtime.speakingRateWpm * detailShare) / 60),
      )
    : legacyParagraphs * 75;
  const paragraphs = runtime
    ? Math.min(MAX_PARAGRAPHS, Math.max(1, Math.ceil(targetWords / 110)))
    : legacyParagraphs;
  const brandBlock = brandVoice?.trim()
    ? `\n\n## Brand voice (write in this brand's voice):\n${brandVoice.trim()}`
    : "";
  // Structure borrowed from a reference video the user pointed at: pacing and
  // shape only, never its subject matter.
  const styleBlock = referenceStyle?.trim()
    ? `\n\n## Reference style (match this structure and pacing, not its topic):\n${referenceStyle.trim()}`
    : "";
  return `# Role: Short Video Script Writer

## Goals:
Write the narration script for a short vertical video about the given subject, plus stock-footage search terms that visually match it.

## Script constraints:
1. Write exactly ${paragraphs} paragraph${paragraphs > 1 ? "s" : ""} of spoken narration and no more than ${targetWords} spoken words.
2. Get straight to the point; never start with filler like "welcome to this video".
3. No markdown, no titles, no formatting — only the raw spoken words.
4. Never include "voiceover", "narrator" or similar speaker indicators.
5. Never mention this prompt, the script itself, or the paragraph count.
6. Write the script in the exact language the Video Subject below is written in — never translate or switch languages. If the subject is written in English, every word of the script must be English. Only use another language when the subject itself is written in that language.
7. Give the narration a narrative arc: an opening hook that lands the subject immediately, one or more development beats that deepen the idea, and a payoff that closes with impact. Each paragraph is one beat.
8. Favor concrete, sensory language — specific sights, textures, sounds, and atmosphere — over abstract adjectives.${brandBlock}${styleBlock}

## Search term constraints:
1. Return 5 stock-video search terms that follow the order of topics in the script; earlier terms must describe earlier visual moments.
2. Each term is 1-3 words and includes the main subject of the video.
3. Terms must be in English only, whatever language the script uses.

## Output:
Respond with ONLY a JSON object of this exact shape:
{"script": "the full narration", "searchTerms": ["term 1", "term 2", "term 3", "term 4", "term 5"]}

## Video Subject:
${topic}`;
}

/** Any `[bracketed]` token: a stage direction, a delivery cue, a [VERIFY] flag. */
const BRACKET_TOKEN_RE = /\[[^\]]*\]/g;

export interface CleanedScript {
  /** Spoken text, safe to hand to TTS or a lip-sync provider. */
  text: string;
  /** Every bracketed token removed, in order of appearance. */
  stripped: string[];
}

/**
 * Strip leftover markdown and stage directions the model may sneak in, and
 * REPORT what was stripped.
 *
 * The reporting matters: a governed prompt can ask the model to flag unproven
 * claims as `[VERIFY: ...]` and to mark delivery with cues like
 * `[pause:short]`. Dropping those on the floor silently would make the flag
 * useless and the cue invisible — the caller lifts them out of `stripped`
 * instead. Spoken text itself must stay bracket-free, so the stripping is
 * still correct; only the silence was wrong.
 */
export function cleanScriptDetailed(raw: string): CleanedScript {
  const withoutMarkdown = raw.replace(/[*#]/g, "");
  const stripped = withoutMarkdown.match(BRACKET_TOKEN_RE) ?? [];
  const text = withoutMarkdown
    .replace(BRACKET_TOKEN_RE, " ")
    // Collapse the space the removal leaves behind, and tidy the punctuation
    // it can strand ("word [cue], next" -> "word, next").
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text, stripped };
}

/** Strip leftover markdown/stage directions the model may sneak in. */
export function cleanScript(raw: string): string {
  return cleanScriptDetailed(raw).text;
}

/**
 * Light clean for text that is ALLOWED to carry delivery cues (beat-level
 * spoken lines shown to a human, never sent to TTS as-is). Markdown goes,
 * brackets stay.
 */
export function cleanCuedText(raw: string): string {
  return raw.replace(/[*#]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

function sanitizeTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/** One LLM call: topic in, narration script + ordered search terms out. */
export async function generateTopicScript(params: {
  tenantAiModel: string;
  topic: string;
  paragraphCount: number;
  /** Optional brand-voice hint (traits, audience, terms to avoid). */
  brandVoice?: string | null;
  /** Optional structural guidance derived from a reference video. */
  referenceStyle?: string | null;
  /** Enables the governed prompt (Prompt Template Kit) when provided. */
  tenantId?: number | null;
  /** Prompt Kit style variant; null keeps the flow's base prompt. */
  variant?: PromptVariantKey | null;
  /** Resolved long-form template settings; null preserves legacy 1..3 sizing. */
  runtime?: VideoTemplateRuntimeSettings | null;
}): Promise<TopicScript & { model: string }> {
  const textGen = await getTextGenClient(params.tenantAiModel);

  // Prompt Template Kit: a production template for the video_script flow
  // replaces the built-in system prompt. Video jobs run in the background
  // with no per-user session, so per-user customizations do not apply here
  // (customizationId: null). Fail-open: null keeps the built-in prompt.
  const governed = params.tenantId
    ? await getGovernedPrompt({
        flowKey: "video_script",
        variantKey: params.variant ?? null,
        tenantId: params.tenantId,
        clerkUserId: "",
        customizationId: null,
        runtimeContext: [
          params.brandVoice?.trim()
            ? `Brand voice: ${params.brandVoice.trim()}`
            : null,
          params.referenceStyle?.trim()
            ? `Reference style (structure/pacing only): ${params.referenceStyle.trim()}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        outputFormat:
          'Respond with ONLY a JSON object of this exact shape: {"script": "the full narration", "searchTerms": ["term 1", "term 2", "term 3", "term 4", "term 5"]}. Search terms must be English, 1-3 words each.',
        placeholderValues: {
          topic: params.topic,
          paragraphCount: String(params.paragraphCount),
        },
      })
    : null;

  const systemPrompt = governed
    ? governed.text
    : "You write narration scripts for short social videos and reply with strict JSON only.";
  const startedAt = Date.now();
  const completion = await textGen.client.chat.completions.create({
    model: textGen.model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: buildTopicScriptPrompt(
          params.topic,
          params.paragraphCount,
          params.brandVoice ?? null,
          params.referenceStyle ?? null,
            params.runtime ?? null,
        ),
      },
    ],
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    ...usageAccountingParams(textGen.provider),
  });
  if (governed && params.tenantId) {
    await logCompiledPrompt({
      tenantId: params.tenantId,
      flowKey: "video_script",
      governed,
      generationContext: {
        model: textGen.model,
        paragraphCount: params.paragraphCount,
        requestedVariant: params.variant ?? null,
        resolvedVariant: governed.resolvedVariantKey,
        missingPlaceholders: governed.missingPlaceholders,
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
  }

  const raw = completion.choices[0]?.message?.content ?? "";
  let parsed: { script?: unknown; searchTerms?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoGenProviderError("The AI returned an unreadable script. Please try again.");
  }
  const cleaned = cleanScriptDetailed(typeof parsed.script === "string" ? parsed.script : "");
  const script = cleaned.text;
  const verificationFindings = cleaned.stripped.filter((token) => /\[\s*verify\b/i.test(token));
  const searchTerms = sanitizeTerms(parsed.searchTerms);
  if (!script) {
    throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
  }
  if (searchTerms.length === 0) {
    // A script with no usable terms can still ship: fall back to the topic
    // itself as the single search term.
    searchTerms.push(params.topic.slice(0, 60));
  }
  return { script, searchTerms, model: textGen.model, verificationFindings };
}
