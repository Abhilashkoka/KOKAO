import { getTextGenClient } from "../../textGen";
import { usageAccountingParams } from "../../aiCost";
import { VideoGenProviderError } from "../types";

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
}

/** ~1 paragraph ≈ 30s of narration; the UI offers 1..3. */
export const MAX_PARAGRAPHS = 3;

export function buildTopicScriptPrompt(topic: string, paragraphCount: number): string {
  const paragraphs = Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), MAX_PARAGRAPHS);
  return `# Role: Short Video Script Writer

## Goals:
Write the narration script for a short vertical video about the given subject, plus stock-footage search terms that visually match it.

## Script constraints:
1. Write exactly ${paragraphs} paragraph${paragraphs > 1 ? "s" : ""} of spoken narration.
2. Get straight to the point; never start with filler like "welcome to this video".
3. No markdown, no titles, no formatting — only the raw spoken words.
4. Never include "voiceover", "narrator" or similar speaker indicators.
5. Never mention this prompt, the script itself, or the paragraph count.
6. Write the script in the same language as the video subject.

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

/** Strip leftover markdown/stage directions the model may sneak in. */
export function cleanScript(raw: string): string {
  let text = raw.replace(/[*#]/g, "");
  text = text.replace(/\[[^\]]*\]/g, "");
  return text.trim();
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
}): Promise<TopicScript & { model: string }> {
  const textGen = await getTextGenClient(params.tenantAiModel);
  const completion = await textGen.client.chat.completions.create({
    model: textGen.model,
    messages: [
      {
        role: "system",
        content:
          "You write narration scripts for short social videos and reply with strict JSON only.",
      },
      { role: "user", content: buildTopicScriptPrompt(params.topic, params.paragraphCount) },
    ],
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    ...usageAccountingParams(textGen.provider),
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  let parsed: { script?: unknown; searchTerms?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoGenProviderError("The AI returned an unreadable script. Please try again.");
  }
  const script = cleanScript(typeof parsed.script === "string" ? parsed.script : "");
  const searchTerms = sanitizeTerms(parsed.searchTerms);
  if (!script) {
    throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
  }
  if (searchTerms.length === 0) {
    // A script with no usable terms can still ship: fall back to the topic
    // itself as the single search term.
    searchTerms.push(params.topic.slice(0, 60));
  }
  return { script, searchTerms, model: textGen.model };
}
