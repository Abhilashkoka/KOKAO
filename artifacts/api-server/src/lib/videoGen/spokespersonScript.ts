import { buildTextCostMeta, usageAccountingParams } from "../aiCost";
import { getGovernedPrompt, logCompiledPrompt } from "../promptKit";
import { getTextGenClient } from "../textGen";
import { parseModelJsonObject } from "../modelJson";
import { VideoGenProviderError } from "./types";
import { cleanCuedText, cleanScriptDetailed } from "./topicVideo/script";
import { characterDialogueLocale } from "./characterDialogue";
import {
  countSpokenWords,
  resolveScriptInputs,
  sanitizeLine,
  type ResolvedScriptInputs,
  type ScriptInputOverrides,
  type ScriptVariantKey,
} from "./scriptInputs";

/**
 * Direct-to-camera spokesperson scripts.
 *
 * Returns a production doc, not just a paragraph: the clean spoken text the
 * lip-sync and TTS paths consume, plus beat-by-beat direction with delivery
 * cues, plus the open items a human must confirm before recording.
 *
 * The split matters. Delivery cues like [pause:short] and truth flags like
 * [VERIFY: ...] must never reach a voice engine, but they must also never be
 * silently dropped — the model is asked for them in a separate field, and
 * anything that leaks into the spoken text is lifted out rather than deleted.
 */

/** Beat framing values the composer understands. */
const FRAMINGS = ["medium", "medium-close", "close"] as const;
type Framing = (typeof FRAMINGS)[number];

export interface ScriptBeat {
  id: string;
  label: string;
  spoken: string;
  onScreen: string;
  bRoll: string;
  framing: Framing;
  durationSec: number;
  note: string | null;
}

export interface ScriptMeta {
  wordCount: number;
  estimatedDurationSec: number;
  takeaway: string;
  cta: string | null;
  openItems: string[];
  pronunciations: Array<{ term: string; saidAs: string }>;
}

export interface SpokespersonScriptResult {
  script: string;
  variant: ScriptVariantKey | null;
  beats: ScriptBeat[];
  meta: ScriptMeta;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costPaise: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Cap on the clean spoken text. The old flat 2000 was tuned for a ~45s script
 * and silently rejected anything longer; a 300s script at 200 wpm is about
 * 6000 characters, so the ceiling scales with the request and only ever
 * catches a genuine runaway.
 */
export function maxScriptChars(inputs: ResolvedScriptInputs): number {
  return Math.max(2000, Math.ceil(inputs.wordBudgetMax * 12));
}

/**
 * Enforce the selected runtime even when the model ignores its word ceiling.
 * Prefer a complete sentence near the limit; if there is none, retain exactly
 * the maximum number of words rather than returning an overlong draft.
 */
export function fitScriptToWordBudget(script: string, maxWords: number): string {
  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");

  const limited = words.slice(0, maxWords);
  const sentenceFloor = Math.max(1, Math.floor(maxWords * 0.7));
  for (let i = limited.length - 1; i >= sentenceFloor - 1; i -= 1) {
    if (/[.!?]["'”’)]?$/.test(limited[i]!)) {
      return limited.slice(0, i + 1).join(" ");
    }
  }
  return limited.join(" ");
}

const OUTPUT_FORMAT = [
  "Respond with ONLY strict JSON of this exact shape:",
  '{"script":"clean spoken text, no cues, no brackets",',
  '"beats":[{"label":"Hook","spoken":"lines WITH cues","onScreen":"<=6 words","bRoll":"what to cut to, or presenter hold","framing":"medium|medium-close|close","durationSec":5,"note":null}],',
  '"takeaway":"the one sentence","cta":"the single action or null",',
  '"openItems":["every [VERIFY] flag and assumption"],',
  '"pronunciations":[{"term":"PayLane","saidAs":"pay-lane"}]}',
  "The script field and the beats must say the same thing: beats carry the direction, script carries the words a voice engine will read.",
].join("\n");

export function buildSpokespersonScriptPrompt(
  topic: string,
  inputs: ResolvedScriptInputs,
  targetLocale?: { label: string; endonym: string; bcp47: string } | null,
): string {
  return `# Task: write a direct-to-camera spokesperson script

Write a script one person can speak naturally to camera about the topic below,
then break it into production beats.

## Requirements
1. The maximum word count in Context is a HARD CEILING. Count only the words in the "script" field. If the topic does not fit, omit secondary details; never exceed the maximum.
2. Open with a specific hook, develop one clear idea, and close on the takeaway.
3. Beats must sum to roughly ${inputs.durationSeconds} seconds and cover the whole script in order.
4. "script" is the clean spoken text: no cues, no brackets, no markdown, no speaker labels, nothing a voice engine would misread.
5. Cues belong in the beats' "spoken" fields only.
6. Every claim not listed under approved facts must appear in "openItems" as well as being marked [VERIFY: ...] in the beat that needs it.
7. ${targetLocale
    ? `Write ONLY in ${targetLocale.label} (${targetLocale.endonym}, ${targetLocale.bcp47}). Translate the presentation faithfully, but preserve every user-supplied fact, proper name, number, URL, and quoted text exactly.`
    : "Write in the same language as the topic. Never translate it."}

## Output
${OUTPUT_FORMAT}

## Topic
${topic}`;
}

// ---------------------------------------------------------------------------
// Response parsing

function coerceFraming(raw: unknown): Framing {
  return (FRAMINGS as readonly string[]).includes(raw as string)
    ? (raw as Framing)
    : "medium";
}

function coerceDuration(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n * 10) / 10, 0.5), 120);
}

/**
 * Rescale beat durations so they sum to the requested runtime.
 *
 * Models are reliably wrong about timing in one direction or another, and a
 * storyboard whose beats sum to 80 seconds for a 45-second video produces a
 * render that gets truncated at the end. Proportional rescaling keeps the
 * model's relative pacing — which is the part it is actually good at — while
 * making the total honest.
 */
export function normalizeBeatDurations(
  beats: ScriptBeat[],
  targetSec: number,
): ScriptBeat[] {
  if (beats.length === 0) return beats;
  const total = beats.reduce((sum, b) => sum + b.durationSec, 0);
  if (total <= 0) {
    const even = Math.round((targetSec / beats.length) * 10) / 10;
    return beats.map((b) => ({ ...b, durationSec: even }));
  }
  const scale = targetSec / total;
  // Leave it alone when the model was already close; rescaling by 1.02 just
  // introduces rounding noise into numbers a human is about to read.
  if (Math.abs(scale - 1) < 0.1) return beats;
  return beats.map((b) => ({
    ...b,
    durationSec: Math.max(0.5, Math.round(b.durationSec * scale * 10) / 10),
  }));
}

function parseBeats(raw: unknown, inputs: ResolvedScriptInputs): ScriptBeat[] {
  if (!Array.isArray(raw)) return [];
  const fallbackDuration = inputs.durationSeconds / Math.max(raw.length, 1);
  const beats: ScriptBeat[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const spoken = typeof obj.spoken === "string" ? cleanCuedText(obj.spoken) : "";
    if (!spoken) continue;
    beats.push({
      id: `b${beats.length + 1}`,
      label: sanitizeLine(obj.label, 60) ?? `Beat ${i + 1}`,
      spoken,
      // On-screen text is a hard six words: it is rendered into a lower third
      // that clips, so trimming here beats clipping at render time.
      onScreen: (sanitizeLine(obj.onScreen, 120) ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .join(" "),
      bRoll: sanitizeLine(obj.bRoll, 300) ?? "presenter hold",
      framing: coerceFraming(obj.framing),
      durationSec: coerceDuration(obj.durationSec, fallbackDuration),
      note: sanitizeLine(obj.note, 300),
    });
    if (beats.length >= 24) break;
  }
  return normalizeBeatDurations(beats, inputs.durationSeconds);
}

function parsePronunciations(
  raw: unknown,
): Array<{ term: string; saidAs: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ term: string; saidAs: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const term = sanitizeLine(obj.term, 80);
    const saidAs = sanitizeLine(obj.saidAs, 120);
    if (term && saidAs) out.push({ term, saidAs });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Collect open items from the model's own list AND from any [VERIFY] marker
 * that leaked into text we had to clean. The second half is the point: a flag
 * the cleaner removed would otherwise vanish without trace.
 */
export function collectOpenItems(
  declared: unknown,
  strippedTokens: string[],
  beats: ScriptBeat[],
): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null) => {
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(value);
  };

  if (Array.isArray(declared)) {
    for (const d of declared) push(sanitizeLine(d, 300));
  }
  const verifyIn = (token: string) => {
    const match = /^\[\s*VERIFY\s*:?\s*(.*?)\s*\]$/i.exec(token);
    if (!match) return;
    push(sanitizeLine(match[1] || "Unspecified claim needs confirming", 300));
  };
  for (const token of strippedTokens) verifyIn(token);
  for (const beat of beats) {
    for (const token of beat.spoken.match(/\[[^\]]*\]/g) ?? []) verifyIn(token);
  }
  return items.slice(0, 30);
}

// ---------------------------------------------------------------------------

export async function generateSpokespersonScript(params: {
  tenantId: number;
  tenantAiModel: string;
  topic: string;
  variant?: ScriptVariantKey | null;
  durationSeconds?: number | null;
  brandKitId?: number | null;
  styleProfileId?: number | null;
  targetLocale?: string | null;
  overrides?: ScriptInputOverrides;
}): Promise<SpokespersonScriptResult> {
  const textGen = await getTextGenClient(params.tenantAiModel);
  const inputs = await resolveScriptInputs({
    tenantId: params.tenantId,
    durationSeconds: params.durationSeconds,
    brandKitId: params.brandKitId,
    styleProfileId: params.styleProfileId,
    overrides: params.overrides,
  });

  const governed = await getGovernedPrompt({
    flowKey: "video_script",
    variantKey: params.variant ?? null,
    tenantId: params.tenantId,
    clerkUserId: "",
    customizationId: null,
    runtimeContext: [
      "Format: one direct-to-camera spokesperson speaking naturally.",
      inputs.runtimeContext,
    ].join("\n"),
    outputFormat: OUTPUT_FORMAT,
    placeholderValues: {
      topic: params.topic,
      paragraphCount: "1",
    },
  });

  const startedAt = Date.now();
  const completion = await textGen.client.chat.completions.create({
    model: textGen.model,
    messages: [
      {
        role: "system",
        content:
          governed?.text ??
          "You write concise, natural direct-to-camera scripts and reply with strict JSON only.",
      },
      {
        role: "user",
        content: buildSpokespersonScriptPrompt(
          params.topic,
          inputs,
          params.targetLocale ? characterDialogueLocale(params.targetLocale) : null,
        ),
      },
    ],
    // A production doc is several times the size of a bare script.
    max_completion_tokens: 4096,
    response_format: { type: "json_object" },
    ...usageAccountingParams(textGen.provider),
  });

  const parsed = parseModelJsonObject(
    completion.choices[0]?.message?.content ?? "",
  );
  const cleaned = cleanScriptDetailed(
    typeof parsed?.script === "string" ? parsed.script : "",
  );
  const rawScript = cleaned.text;
  const script = fitScriptToWordBudget(rawScript, inputs.wordBudgetMax);
  const parsedBeats = parseBeats(parsed?.beats, inputs);
  // Truncating only the clean script would make the production beats say extra
  // words. Fall back to one honest beat so every downstream voice/render path
  // receives the same bounded script.
  const beats =
    script === rawScript
      ? parsedBeats
      : [
          {
            id: "b1",
            label: "Script",
            spoken: script,
            onScreen: "",
            bRoll: "presenter hold",
            framing: "medium" as const,
            durationSec: inputs.durationSeconds,
            note: null,
          },
        ];
  const openItems = collectOpenItems(parsed?.openItems, cleaned.stripped, beats);
  const wordCount = countSpokenWords(script);

  if (governed) {
    await logCompiledPrompt({
      tenantId: params.tenantId,
      flowKey: "video_script",
      governed,
      generationContext: {
        model: textGen.model,
        format: "spokesperson",
        requestedVariant: params.variant ?? null,
        resolvedVariant: governed.resolvedVariantKey,
        // Surfaced deliberately: a template referencing a placeholder no
        // caller supplies compiles to an empty string, which is otherwise
        // invisible until someone reads a bad script.
        missingPlaceholders: governed.missingPlaceholders,
        wordBudget: inputs.wordBudget,
        wordCount,
        beatCount: beats.length,
        openItemCount: openItems.length,
      },
      success: script.length > 0,
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

  if (!script) {
    throw new VideoGenProviderError(
      "The AI returned an empty script. Please try again.",
    );
  }
  if (script.length > maxScriptChars(inputs)) {
    throw new VideoGenProviderError(
      "The AI returned a script that is too long. Please try again.",
    );
  }

  const costMeta = await buildTextCostMeta(completion, textGen);
  return {
    script,
    variant: params.variant ?? null,
    beats,
    meta: {
      wordCount,
      estimatedDurationSec:
        Math.round((wordCount / inputs.wordsPerMinute) * 60 * 10) / 10,
      takeaway:
        sanitizeLine(parsed?.takeaway, 500) ?? inputs.desiredTakeaway ?? "",
      cta: sanitizeLine(parsed?.cta, 200) ?? inputs.cta,
      openItems,
      pronunciations: parsePronunciations(parsed?.pronunciations),
    },
    provider: textGen.provider,
    model: textGen.model,
    inputTokens: completion.usage?.prompt_tokens ?? null,
    outputTokens: completion.usage?.completion_tokens ?? null,
    costPaise: costMeta.costPaise ?? null,
    cachedInputTokens: costMeta.cachedInputTokens ?? null,
    reasoningTokens: costMeta.reasoningTokens ?? null,
  };
}
