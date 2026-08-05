import { platformFetch } from "./platformFetch";
import { logger } from "./logger";

/**
 * Live per-model pricing looked up from OpenRouter's PUBLIC model catalog
 * (https://openrouter.ai/api/v1/models — no API key required), shown next to
 * model names in the model-selection dropdowns.
 *
 * Fail-soft by design: pricing is decorative, so a catalog outage must never
 * break model selection — lookups then return null prices, never throw.
 */
export interface ModelPricing {
  model: string;
  /** USD per 1M input (prompt) tokens, null when unknown. */
  inputPerMTokens: number | null;
  /** USD per 1M output (completion) tokens, null when unknown. */
  outputPerMTokens: number | null;
  /**
   * USD per 1M output IMAGE tokens, null when unknown. Image-capable models
   * (e.g. google/gemini-2.5-flash-image) bill generated images as image
   * output tokens at this rate, not at the text completion rate.
   */
  imageOutputPerMTokens: number | null;
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000; // pricing changes rarely; 1h is plenty

let cache: { fetchedAt: number; byId: Map<string, ModelPricing> } | null = null;
let inflight: Promise<Map<string, ModelPricing>> | null = null;

/** Parse OpenRouter's per-token USD price string into USD per 1M tokens. */
function perMillion(perToken: unknown): number | null {
  const n = Number(perToken);
  if (!Number.isFinite(n) || n < 0) return null;
  // Round to 4 decimals to avoid float noise like 0.15000000000000002.
  return Math.round(n * 1_000_000 * 10_000) / 10_000;
}

async function loadCatalog(): Promise<Map<string, ModelPricing>> {
  if (cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) return cache.byId;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await platformFetch(CATALOG_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`OpenRouter catalog responded ${res.status}`);
      const body = (await res.json()) as {
        data?: Array<{
          id?: string;
          pricing?: { prompt?: unknown; completion?: unknown; image_output?: unknown };
        }>;
      };
      const byId = new Map<string, ModelPricing>();
      for (const m of body.data ?? []) {
        if (!m.id) continue;
        byId.set(m.id, {
          model: m.id,
          inputPerMTokens: perMillion(m.pricing?.prompt),
          outputPerMTokens: perMillion(m.pricing?.completion),
          imageOutputPerMTokens: perMillion(m.pricing?.image_output),
        });
      }
      cache = { fetchedAt: Date.now(), byId };
      return byId;
    } catch (err) {
      logger.warn({ err }, "OpenRouter model catalog fetch failed; pricing unavailable");
      // Serve a stale cache over nothing; otherwise an empty map (null prices).
      return cache?.byId ?? new Map<string, ModelPricing>();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Pricing for the given OpenRouter model ids; unknown models get null prices. */
export async function lookupOpenRouterPricing(models: string[]): Promise<ModelPricing[]> {
  const catalog = await loadCatalog();
  return models.map(
    (model) =>
      catalog.get(model) ?? {
        model,
        inputPerMTokens: null,
        outputPerMTokens: null,
        imageOutputPerMTokens: null,
      },
  );
}

/** Test hook: clear the in-memory catalog cache. */
export function resetOpenRouterCatalogCache(): void {
  cache = null;
  inflight = null;
  videoCache = null;
  videoInflight = null;
}

// ---------------------------------------------------------------------------
// Video model pricing — OpenRouter's video API has its OWN public catalog
// (https://openrouter.ai/api/v1/videos/models, no key required) with
// per-second "pricing_skus" instead of per-token pricing.
// ---------------------------------------------------------------------------

export interface VideoModelPricing {
  model: string;
  /** USD per second of generated video, null when unknown. */
  usdPerSecond: number | null;
}

const VIDEO_CATALOG_URL = "https://openrouter.ai/api/v1/videos/models";

let videoCache: { fetchedAt: number; byId: Map<string, VideoModelPricing> } | null = null;
let videoInflight: Promise<Map<string, VideoModelPricing>> | null = null;

/**
 * The representative USD/second from a model's pricing_skus. SKU names vary
 * by model family; prefer the plain per-second rate, then the cheapest
 * common tier we actually use (720p, no audio). Token-billed models (e.g.
 * Seedance's "video_tokens") have no per-second rate — null, so activation
 * falls through to another catalog or a manual row rather than guessing.
 */
function perSecondFromSkus(skus: Record<string, unknown> | undefined): number | null {
  if (!skus) return null;
  const usd = (key: string): number | null => {
    const n = Number(skus[key]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const cents = (key: string): number | null => {
    const n = usd(key);
    return n === null ? null : Math.round((n / 100) * 10_000) / 10_000;
  };
  return (
    usd("duration_seconds") ??
    usd("duration_seconds_without_audio_720p") ??
    usd("duration_seconds_without_audio") ??
    usd("duration_seconds_720p") ??
    usd("text_to_video_duration_seconds_720p") ??
    usd("image_to_video_duration_seconds_720p") ??
    usd("duration_seconds_with_audio_720p") ??
    usd("duration_seconds_with_audio") ??
    cents("cents_per_second_output_720p") ??
    cents("cents_per_second_output") ??
    cents("cents_per_video_output_second_720p") ??
    null
  );
}

async function loadVideoCatalog(): Promise<Map<string, VideoModelPricing>> {
  if (videoCache && Date.now() - videoCache.fetchedAt < CATALOG_TTL_MS) return videoCache.byId;
  if (videoInflight) return videoInflight;
  videoInflight = (async () => {
    try {
      const res = await platformFetch(VIDEO_CATALOG_URL, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`OpenRouter video catalog responded ${res.status}`);
      const body = (await res.json()) as {
        data?: Array<{ id?: string; pricing_skus?: Record<string, unknown> }>;
      };
      const byId = new Map<string, VideoModelPricing>();
      for (const m of body.data ?? []) {
        if (!m.id) continue;
        byId.set(m.id, { model: m.id, usdPerSecond: perSecondFromSkus(m.pricing_skus) });
      }
      videoCache = { fetchedAt: Date.now(), byId };
      return byId;
    } catch (err) {
      logger.warn({ err }, "OpenRouter video model catalog fetch failed; pricing unavailable");
      return videoCache?.byId ?? new Map<string, VideoModelPricing>();
    } finally {
      videoInflight = null;
    }
  })();
  return videoInflight;
}

/** Per-second pricing for the given OpenRouter VIDEO model ids (fail-soft). */
export async function lookupOpenRouterVideoPricing(
  models: string[],
): Promise<VideoModelPricing[]> {
  const catalog = await loadVideoCatalog();
  return models.map((model) => catalog.get(model) ?? { model, usdPerSecond: null });
}
