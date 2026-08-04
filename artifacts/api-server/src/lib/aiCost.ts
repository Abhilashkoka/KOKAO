import { db, aiModelPricesTable, aiCostSettingsTable, type AiModelPrice } from "@workspace/db";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import { isFeatureEnabled } from "./featureFlags";
import { recordAdminAction } from "./adminAudit";
import { logger } from "./logger";
import { platformFetch } from "./platformFetch";
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
  /** Markup (paise) added on top of the fetched market rate on auto-refresh. */
  rateMarkupPaise: number;
  /** Raw market rate (paise per 1 USD) from the last successful auto-refresh. */
  marketRatePaise: number | null;
  /** When the rate was last auto-refreshed successfully; null = never. */
  rateAutoUpdatedAt: Date | null;
}

/** Default markup added to the market rate when the admin never set one. */
export const DEFAULT_RATE_MARKUP_PAISE = 200;

export async function getAiCostConfig(): Promise<AiCostConfig> {
  const [row] = await db.select().from(aiCostSettingsTable).limit(1);
  return {
    usdToInrPaise: row?.usdToInrPaise ?? 0,
    rateMarkupPaise: row?.rateMarkupPaise ?? DEFAULT_RATE_MARKUP_PAISE,
    marketRatePaise: row?.marketRatePaise ?? null,
    rateAutoUpdatedAt: row?.rateAutoUpdatedAt ?? null,
  };
}

/** Manual rate override — leaves the auto-refresh metadata untouched. */
export async function setAiCostConfig(config: { usdToInrPaise: number }): Promise<AiCostConfig> {
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, usdToInrPaise: config.usdToInrPaise })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: { usdToInrPaise: config.usdToInrPaise, updatedAt: new Date() },
    });
  return getAiCostConfig();
}

/** Update the auto-refresh markup; applies on the next refresh. */
export async function setAiCostMarkup(rateMarkupPaise: number): Promise<AiCostConfig> {
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, rateMarkupPaise })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: { rateMarkupPaise, updatedAt: new Date() },
    });
  return getAiCostConfig();
}

/** Keyless USD→INR source. Overridable so tests can point at a mock. */
export const USD_INR_RATE_URL =
  process.env.USD_INR_RATE_URL ?? "https://open.er-api.com/v6/latest/USD";

/**
 * Fetch the live USD→INR market rate, add the stored markup (default ₹2.00
 * when never set), and save the result as the conversion rate. Throws on any
 * fetch/parse failure WITHOUT touching the stored rate — the last saved rate
 * must never be zeroed or guessed.
 */
export async function refreshUsdInrRate(): Promise<AiCostConfig> {
  const res = await platformFetch(USD_INR_RATE_URL);
  if (!res.ok) {
    throw new Error(`Exchange-rate API responded ${res.status}`);
  }
  const body = (await res.json()) as { rates?: Record<string, unknown> };
  const inr = body?.rates?.INR;
  if (typeof inr !== "number" || !Number.isFinite(inr) || inr <= 0) {
    throw new Error("Exchange-rate API returned no usable INR rate");
  }
  const marketRatePaise = Math.round(inr * 100);
  const { rateMarkupPaise } = await getAiCostConfig();
  const usdToInrPaise = marketRatePaise + rateMarkupPaise;
  const now = new Date();
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, usdToInrPaise, marketRatePaise, rateAutoUpdatedAt: now })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: { usdToInrPaise, marketRatePaise, rateAutoUpdatedAt: now, updatedAt: now },
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
  const provider = input.provider.trim();
  const model = input.model.trim();
  // Match existing rows the same way findPrice() does — trimmed and
  // case-insensitive — so saving "gpt-4o" updates an earlier "GPT-4o" row
  // instead of creating a near-duplicate that can hold a diverging price.
  const matches = await db
    .select()
    .from(aiModelPricesTable)
    .where(
      and(
        eq(aiModelPricesTable.kind, input.kind),
        sql`lower(trim(${aiModelPricesTable.provider})) = lower(${provider})`,
        sql`lower(trim(${aiModelPricesTable.model})) = lower(${model})`,
      ),
    )
    .orderBy(asc(aiModelPricesTable.id));

  const prices = {
    inputUsdPerMtok: input.inputUsdPerMtok,
    outputUsdPerMtok: input.outputUsdPerMtok,
    usdPerImage: input.usdPerImage,
    usdPerSecond: input.usdPerSecond,
    usdPerVideo: input.usdPerVideo,
  };

  if (matches.length > 0) {
    // Update the oldest matching row in place. Keep its stored key strings
    // (its casing is what lookups already resolve to) rather than rewriting
    // them, which could collide with a pre-existing exact-key duplicate.
    const target = matches[0];
    const [row] = await db
      .update(aiModelPricesTable)
      .set({ ...prices, updatedAt: new Date() })
      .where(eq(aiModelPricesTable.id, target.id))
      .returning();
    // Any remaining rows are case/whitespace duplicates from before this
    // normalization existed — fold them into the canonical row by deleting
    // them, so the admin card shows one row with one price.
    if (matches.length > 1) {
      await db.delete(aiModelPricesTable).where(
        inArray(
          aiModelPricesTable.id,
          matches.slice(1).map((m) => m.id),
        ),
      );
    }
    return row;
  }

  const [row] = await db
    .insert(aiModelPricesTable)
    .values({ ...input, provider, model })
    .onConflictDoUpdate({
      target: [aiModelPricesTable.kind, aiModelPricesTable.provider, aiModelPricesTable.model],
      set: { ...prices, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** One merged duplicate group, for auditing/logging. */
export interface ModelPriceMerge {
  kind: string;
  /** Normalized (trimmed, lowercased) provider/model key of the group. */
  provider: string;
  model: string;
  /** The surviving row after the merge. */
  keptId: number;
  /** Stored key strings of the kept row (its casing is what lookups resolve to). */
  keptProvider: string;
  keptModel: string;
  /** Rows folded into the kept row and deleted. */
  removed: { id: number; provider: string; model: string }[];
  /** Whether the kept row's prices were overwritten by a newer duplicate's. */
  pricesTakenFromId: number;
}

/**
 * One-time sweep merging ai_model_prices rows whose kind+provider+model
 * differ only in letter case or surrounding whitespace — historical
 * duplicates from before upsertModelPrice normalized its match. Mirrors the
 * upsert's rules: the OLDEST row (lowest id) survives, keeping its stored
 * key strings, while the prices come from the most recently UPDATED
 * duplicate so the newest numbers win. Runs in one transaction per group so
 * a failure never leaves a group half-merged.
 */
export async function dedupeModelPrices(): Promise<ModelPriceMerge[]> {
  const rows = await db
    .select()
    .from(aiModelPricesTable)
    .orderBy(asc(aiModelPricesTable.id));

  const groups = new Map<string, AiModelPrice[]>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.provider.trim().toLowerCase()}\u0000${row.model.trim().toLowerCase()}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const merges: ModelPriceMerge[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Oldest row is canonical (same choice upsertModelPrice makes).
    const kept = group[0];
    // Newest prices win: the duplicate with the latest updatedAt (ties break
    // toward the highest id, i.e. the most recently created row).
    const newest = [...group].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id,
    )[0];
    const removedIds = group.slice(1).map((r) => r.id);
    await db.transaction(async (tx) => {
      if (newest.id !== kept.id) {
        await tx
          .update(aiModelPricesTable)
          .set({
            inputUsdPerMtok: newest.inputUsdPerMtok,
            outputUsdPerMtok: newest.outputUsdPerMtok,
            usdPerImage: newest.usdPerImage,
            usdPerSecond: newest.usdPerSecond,
            usdPerVideo: newest.usdPerVideo,
            updatedAt: new Date(),
          })
          .where(eq(aiModelPricesTable.id, kept.id));
      }
      await tx.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, removedIds));
    });
    merges.push({
      kind: kept.kind,
      provider: kept.provider.trim().toLowerCase(),
      model: kept.model.trim().toLowerCase(),
      keptId: kept.id,
      keptProvider: kept.provider,
      keptModel: kept.model,
      removed: group.slice(1).map((r) => ({ id: r.id, provider: r.provider, model: r.model })),
      pricesTakenFromId: newest.id,
    });
  }
  return merges;
}

/**
 * Startup sweep: merge historical case/whitespace duplicate price rows once
 * per boot, writing an ai_cost_change audit row per merged group so the
 * cleanup is traceable. Best-effort — a failure is logged and never affects
 * startup. Actor id 0 marks system-initiated (no admin) actions.
 */
export async function sweepDuplicateModelPrices(): Promise<void> {
  try {
    const merges = await dedupeModelPrices();
    for (const merge of merges) {
      try {
        await recordAdminAction({
          action: "ai_cost_change",
          actorTenantId: 0,
          actorEmail: "system (startup dedupe)",
          targetTenantId: null,
          targetEmail: null,
          oldValue: merge.removed
            .map((r) => `duplicate #${r.id} ${merge.kind}:${r.provider}/${r.model}`)
            .join(", "),
          newValue: `merged into #${merge.keptId} ${merge.kind}:${merge.keptProvider}/${merge.keptModel} (prices from #${merge.pricesTakenFromId})`,
        });
      } catch (error) {
        logger.error({ err: error, merge }, "Failed to audit model price dedupe merge");
      }
    }
    if (merges.length > 0) {
      logger.info({ merged: merges.length }, "Merged duplicate AI model price rows");
    }
  } catch (error) {
    logger.error({ err: error }, "Duplicate model price sweep failed");
  }
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
  opts?: { exactProviderOnly?: boolean },
): Promise<AiModelPrice | null> {
  // Comparisons are trimmed and case-insensitive so a manually saved row
  // (e.g. "GPT-4o " typed into the cost card) still matches the activation
  // lookup and cost capture for "gpt-4o". Distinct models stay distinct —
  // only whitespace and letter case are normalized.
  const modelMatches = sql`lower(trim(${aiModelPricesTable.model})) = lower(${model.trim()})`;
  const providerMatches = sql`lower(trim(${aiModelPricesTable.provider})) = lower(${provider.trim()})`;
  const [row] = await db
    .select()
    .from(aiModelPricesTable)
    .where(and(eq(aiModelPricesTable.kind, kind), providerMatches, modelMatches))
    .limit(1);
  if (row || opts?.exactProviderOnly) return row ?? null;
  // Fall back to a model-only match under any provider, so one price row
  // covers e.g. the same model reachable via builtin AND openrouter.
  const [anyProvider] = await db
    .select()
    .from(aiModelPricesTable)
    .where(and(eq(aiModelPricesTable.kind, kind), modelMatches))
    .limit(1);
  return anyProvider ?? null;
}

/** Exported price lookup used by the model activation pricing sync. */
export async function findModelPrice(
  kind: "text" | "image" | "video",
  provider: string,
  model: string,
  opts?: { exactProviderOnly?: boolean },
): Promise<AiModelPrice | null> {
  return findPrice(kind, provider, model, opts);
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
 * Cost of one video generation in paise, or null when unknown.
 * Per-second when the price row has a $/second rate AND the caller measured
 * the output duration; otherwise the flat per-video price. Never guessed.
 */
export async function computeVideoCostPaise(args: {
  provider: string;
  model: string;
  /** Measured output clip length in seconds (ffprobe), not wall-clock time. */
  durationSec?: number | null;
}): Promise<number | null> {
  const price = await findPrice("video", args.provider, args.model);
  if (!price) return null;
  const { usdToInrPaise } = await getAiCostConfig();
  const durationSec = args.durationSec ?? null;
  if (price.usdPerSecond !== null && durationSec !== null && durationSec > 0) {
    return usdToPaise(durationSec * price.usdPerSecond, usdToInrPaise);
  }
  if (price.usdPerVideo === null) return null;
  return usdToPaise(price.usdPerVideo, usdToInrPaise);
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
