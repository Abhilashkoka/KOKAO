import { db, aiModelPricesTable, aiCostSettingsTable, type AiModelPrice } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { isFeatureEnabled } from "./featureFlags";
import type { UsageMeta } from "./usage";
import type { TextGenClient } from "./textGen";

/**
 * Actual AI cost computation (superadmin-only reporting).
 *
 * Provider prices are USD, admin-maintained in ai_model_prices. Conversion
 * to paise uses the admin-set USD→INR rate (paise per 1 USD) in
 * ai_cost_settings. Anything unknown — no price row, no rate — yields a
 * NULL cost, never a guessed number. Everything here is best-effort: cost
 * capture must never break a generation.
 */

export interface AiCostConfig {
  /** Paise per 1 USD (0 = unset; every computed cost stays unknown). */
  usdToInrPaise: number;
}

export async function getAiCostConfig(): Promise<AiCostConfig> {
  const [row] = await db.select().from(aiCostSettingsTable).limit(1);
  return { usdToInrPaise: row?.usdToInrPaise ?? 0 };
}

export async function setAiCostConfig(config: AiCostConfig): Promise<AiCostConfig> {
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, usdToInrPaise: config.usdToInrPaise })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: { usdToInrPaise: config.usdToInrPaise, updatedAt: new Date() },
    });
  return getAiCostConfig();
}

export async function listModelPrices(): Promise<AiModelPrice[]> {
  return db
    .select()
    .from(aiModelPricesTable)
    .orderBy(asc(aiModelPricesTable.kind), asc(aiModelPricesTable.provider), asc(aiModelPricesTable.model));
}

export interface UpsertModelPriceInput {
  kind: "text" | "image" | "video";
  provider: string;
  model: string;
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
  usdPerImage: number | null;
  usdPerSecond: number | null;
  usdPerVideo: number | null;
}

export async function upsertModelPrice(input: UpsertModelPriceInput): Promise<AiModelPrice> {
  const [row] = await db
    .insert(aiModelPricesTable)
    .values(input)
    .onConflictDoUpdate({
      target: [aiModelPricesTable.kind, aiModelPricesTable.provider, aiModelPricesTable.model],
      set: {
        inputUsdPerMtok: input.inputUsdPerMtok,
        outputUsdPerMtok: input.outputUsdPerMtok,
        usdPerImage: input.usdPerImage,
        usdPerSecond: input.usdPerSecond,
        usdPerVideo: input.usdPerVideo,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function deleteModelPrice(id: number): Promise<boolean> {
  const rows = await db.delete(aiModelPricesTable).where(eq(aiModelPricesTable.id, id)).returning();
  return rows.length > 0;
}

/** USD → whole paise via the admin rate; null when the rate is unset. */
export function usdToPaise(usd: number, usdToInrPaise: number): number | null {
  if (!Number.isFinite(usd) || usd < 0) return null;
  if (!Number.isInteger(usdToInrPaise) || usdToInrPaise <= 0) return null;
  return Math.round(usd * usdToInrPaise);
}

async function findPrice(
  kind: "text" | "image" | "video",
  provider: string,
  model: string,
): Promise<AiModelPrice | null> {
  const [row] = await db
    .select()
    .from(aiModelPricesTable)
    .where(
      and(
        eq(aiModelPricesTable.kind, kind),
        eq(aiModelPricesTable.provider, provider),
        eq(aiModelPricesTable.model, model),
      ),
    )
    .limit(1);
  if (row) return row;
  // Fall back to a model-only match under any provider, so one price row
  // covers e.g. the same model reachable via builtin AND openrouter.
  const [anyProvider] = await db
    .select()
    .from(aiModelPricesTable)
    .where(and(eq(aiModelPricesTable.kind, kind), eq(aiModelPricesTable.model, model)))
    .limit(1);
  return anyProvider ?? null;
}

/** Token-based cost of a text generation in paise, or null when unknown. */
export async function computeTextCostPaise(args: {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}): Promise<number | null> {
  const { inputTokens, outputTokens } = args;
  if (inputTokens === null || outputTokens === null) return null;
  const price = await findPrice("text", args.provider, args.model);
  if (!price || price.inputUsdPerMtok === null || price.outputUsdPerMtok === null) return null;
  const { usdToInrPaise } = await getAiCostConfig();
  const usd =
    (inputTokens / 1_000_000) * price.inputUsdPerMtok +
    (outputTokens / 1_000_000) * price.outputUsdPerMtok;
  return usdToPaise(usd, usdToInrPaise);
}

/**
 * Cost of one image generation in paise, or null when unknown.
 * Token-based when the price row has token prices AND the provider reported
 * token usage (OpenAI gpt-image-1, Gemini); otherwise the flat per-image
 * price. Never guessed.
 */
export async function computeImageCostPaise(args: {
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): Promise<number | null> {
  const price = await findPrice("image", args.provider, args.model);
  if (!price) return null;
  const { usdToInrPaise } = await getAiCostConfig();
  const { inputTokens = null, outputTokens = null } = args;
  if (
    price.inputUsdPerMtok !== null &&
    price.outputUsdPerMtok !== null &&
    inputTokens !== null &&
    outputTokens !== null
  ) {
    const usd =
      (inputTokens / 1_000_000) * price.inputUsdPerMtok +
      (outputTokens / 1_000_000) * price.outputUsdPerMtok;
    return usdToPaise(usd, usdToInrPaise);
  }
  if (price.usdPerImage === null) return null;
  return usdToPaise(price.usdPerImage, usdToInrPaise);
}

/**
 * Best-effort flat per-image price in paise for each candidate, keyed by the
 * caller's id. One query for the whole price table rather than one per
 * candidate, because this runs while choosing a provider.
 *
 * Deliberately NOT gated on the `aiCostTracking` flag: that switch governs
 * what gets *reported* to superadmins, and turning reporting off should not
 * quietly make the router blind to price. Unknown prices are simply absent
 * from the map — never a guessed number.
 */
export async function imageUnitCostsPaise(
  candidates: { id: string; provider: string; model: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (candidates.length === 0) return out;
  const [rows, { usdToInrPaise }] = await Promise.all([
    db.select().from(aiModelPricesTable).where(eq(aiModelPricesTable.kind, "image")),
    getAiCostConfig(),
  ]);
  if (rows.length === 0 || usdToInrPaise <= 0) return out;
  for (const candidate of candidates) {
    // Same precedence as findPrice(): an exact provider+model row wins, then
    // any provider offering that model (one price row can cover a model
    // reachable both directly and through a gateway).
    const price =
      rows.find((r) => r.provider === candidate.provider && r.model === candidate.model) ??
      rows.find((r) => r.model === candidate.model);
    if (!price || price.usdPerImage === null) continue;
    const paise = usdToPaise(price.usdPerImage, usdToInrPaise);
    if (paise !== null) out.set(candidate.id, paise);
  }
  return out;
}

/**
 * Shape of the usage block on a chat completion (OpenRouter adds `cost`).
 * Exported because the streaming routes accumulate one of these by hand from
 * the final chunk, and two hand-written copies of the shape would drift.
 */
export interface CompletionUsageLike {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter: exact request cost in USD when usage accounting is on. */
    cost?: number;
    /** Subset of prompt_tokens the provider served from its own cache. */
    prompt_tokens_details?: { cached_tokens?: number } | null;
    /** Subset of completion_tokens spent thinking rather than answering. */
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

/** A reported token count, or null when the provider said nothing. */
function reportedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extra request params that ask OpenRouter to report the exact request cost
 * in the response usage block. Empty for other providers.
 */
export function usageAccountingParams(provider: string): Record<string, unknown> {
  return provider === "openrouter" ? { usage: { include: true } } : {};
}

/**
 * Extra request params that ask for a usage block on a STREAMED completion.
 * Without this a streaming response reports no tokens at all, which is why
 * every streamed generation used to be recorded with a NULL cost. Both
 * supported text backends (built-in OpenAI and OpenRouter) honour it.
 */
export function streamUsageParams(): Record<string, unknown> {
  return { stream_options: { include_usage: true } };
}

export type TextCostMeta = Pick<
  UsageMeta,
  | "provider"
  | "inputTokens"
  | "outputTokens"
  | "costPaise"
  | "cachedInputTokens"
  | "reasoningTokens"
>;

/**
 * Cost-related usage metadata for a finished text generation. Best-effort:
 * any failure (or the tracking kill switch being off) returns {} so the
 * generation and its usage row are never affected.
 *
 * When OpenRouter reports its exact per-request USD cost, that number is
 * used instead of the price-table estimate.
 *
 * The cached/reasoning split is recorded but deliberately does NOT change the
 * cost formula: discounting cached prompt tokens needs its own price column
 * per model, and inventing a discount would be worse than a known
 * overstatement. Recording the split is what makes that overstatement
 * visible — and quantifiable — instead of invisible.
 */
export async function buildTextCostMeta(
  completion: CompletionUsageLike,
  textGen: Pick<TextGenClient, "provider" | "model">,
): Promise<TextCostMeta> {
  try {
    if (!(await isFeatureEnabled("aiCostTracking"))) return {};
    const usage = completion.usage ?? null;
    const inputTokens =
      typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null;
    const outputTokens =
      typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null;
    let costPaise: number | null = null;
    if (textGen.provider === "openrouter" && typeof usage?.cost === "number") {
      const { usdToInrPaise } = await getAiCostConfig();
      costPaise = usdToPaise(usage.cost, usdToInrPaise);
    } else {
      costPaise = await computeTextCostPaise({
        provider: textGen.provider,
        model: textGen.model,
        inputTokens,
        outputTokens,
      });
    }
    const cachedInputTokens = reportedCount(usage?.prompt_tokens_details?.cached_tokens);
    const reasoningTokens = reportedCount(usage?.completion_tokens_details?.reasoning_tokens);
    return {
      provider: textGen.provider,
      inputTokens: inputTokens ?? undefined,
      outputTokens: outputTokens ?? undefined,
      costPaise: costPaise ?? undefined,
      cachedInputTokens: cachedInputTokens ?? undefined,
      reasoningTokens: reasoningTokens ?? undefined,
    };
  } catch {
    return {};
  }
}

export type ImageCostMeta = Pick<
  UsageMeta,
  "provider" | "inputTokens" | "outputTokens" | "costPaise"
>;

/** Cost-related usage metadata for a finished image generation. Best-effort. */
export async function buildImageCostMeta(args: {
  provider: string;
  model: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}): Promise<ImageCostMeta> {
  try {
    if (!(await isFeatureEnabled("aiCostTracking"))) return {};
    const inputTokens = args.usage?.inputTokens ?? null;
    const outputTokens = args.usage?.outputTokens ?? null;
    const costPaise = await computeImageCostPaise({
      provider: args.provider,
      model: args.model,
      inputTokens,
      outputTokens,
    });
    return {
      provider: args.provider,
      inputTokens: inputTokens ?? undefined,
      outputTokens: outputTokens ?? undefined,
      costPaise: costPaise ?? undefined,
    };
  } catch {
    return {};
  }
}
