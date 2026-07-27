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
        data?: Array<{ id?: string; pricing?: { prompt?: unknown; completion?: unknown } }>;
      };
      const byId = new Map<string, ModelPricing>();
      for (const m of body.data ?? []) {
        if (!m.id) continue;
        byId.set(m.id, {
          model: m.id,
          inputPerMTokens: perMillion(m.pricing?.prompt),
          outputPerMTokens: perMillion(m.pricing?.completion),
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
      catalog.get(model) ?? { model, inputPerMTokens: null, outputPerMTokens: null },
  );
}

/** Test hook: clear the in-memory catalog cache. */
export function resetOpenRouterCatalogCache(): void {
  cache = null;
  inflight = null;
}
