import { findModelPrice, upsertModelPrice, type UpsertModelPriceInput } from "./aiCost";
import { lookupOpenRouterPricing } from "./openrouterCatalog";
import { lookupReplicateTokenPricing, lookupReplicateUnitPricing } from "./replicateCatalog";

/**
 * Pricing sync for admin model activation.
 *
 * Whenever a superadmin activates or changes an AI model (text, image or
 * video), we pull its current price from the provider's public catalog and
 * upsert it into ai_model_prices so the Actual AI cost tracking card always
 * reflects the active models. A model with NO resolvable price — nothing in
 * the catalog and no manually entered row — must NOT activate; the caller
 * turns the returned `missing` list into a 400.
 *
 * Merge rule: a successful catalog lookup refreshes the fields it actually
 * resolved and preserves any other fields on an existing row (e.g. a manual
 * flat $/video next to a scraped $/second). A failed lookup never erases an
 * existing manual price.
 */

export type PricedKind = "text" | "image" | "video";

interface LookedUpPrices {
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
  usdPerImage: number | null;
  usdPerSecond: number | null;
  usdPerVideo: number | null;
}

const EMPTY: LookedUpPrices = {
  inputUsdPerMtok: null,
  outputUsdPerMtok: null,
  usdPerImage: null,
  usdPerSecond: null,
  usdPerVideo: null,
};

function hasAnyPrice(p: LookedUpPrices): boolean {
  return (
    p.inputUsdPerMtok !== null ||
    p.outputUsdPerMtok !== null ||
    p.usdPerImage !== null ||
    p.usdPerSecond !== null ||
    p.usdPerVideo !== null
  );
}

/** Live catalog lookup for one model; EMPTY when no catalog covers it. */
async function lookupLive(
  kind: PricedKind,
  provider: string,
  model: string,
): Promise<LookedUpPrices> {
  try {
    if (kind === "text" && provider === "openrouter") {
      const [p] = await lookupOpenRouterPricing([model]);
      return {
        ...EMPTY,
        inputUsdPerMtok: p?.inputPerMTokens ?? null,
        outputUsdPerMtok: p?.outputPerMTokens ?? null,
      };
    }
    if (kind === "image" && provider === "openrouter") {
      // OpenRouter image models bill by tokens; generated images count as
      // image OUTPUT tokens, which have their own (much higher) rate than
      // text completion. Prefer it for the output price when published.
      const [p] = await lookupOpenRouterPricing([model]);
      return {
        ...EMPTY,
        inputUsdPerMtok: p?.inputPerMTokens ?? null,
        outputUsdPerMtok: p?.imageOutputPerMTokens ?? p?.outputPerMTokens ?? null,
      };
    }
    if (provider === "replicate") {
      if (kind === "text") {
        const [p] = await lookupReplicateTokenPricing([model]);
        return {
          ...EMPTY,
          inputUsdPerMtok: p?.inputPerMTokens ?? null,
          outputUsdPerMtok: p?.outputPerMTokens ?? null,
        };
      }
      const [p] = await lookupReplicateUnitPricing([model]);
      return {
        ...EMPTY,
        usdPerImage: kind === "image" ? (p?.usdPerImage ?? null) : null,
        usdPerSecond: kind === "video" ? (p?.usdPerSecond ?? null) : null,
        usdPerVideo: kind === "video" ? (p?.usdPerVideo ?? null) : null,
      };
    }
  } catch {
    // Fail-soft: a catalog hiccup falls through to the manual-row check.
  }
  return EMPTY;
}

export interface PricingSyncResult {
  /** Models that could not be priced (no catalog data, no manual row). */
  missing: string[];
}

/**
 * Resolve pricing for every model being activated. Catalog hits are upserted
 * into ai_model_prices (so the cost-tracking card updates immediately);
 * models covered by neither the catalog nor a manual row are returned in
 * `missing` and the caller must refuse the activation.
 */
export async function syncActivatedModelPricing(args: {
  kind: PricedKind;
  provider: string;
  models: string[];
}): Promise<PricingSyncResult> {
  const models = [...new Set(args.models.map((m) => m.trim()).filter(Boolean))];
  // Lookups run in parallel: each provider catalog already dedupes inflight
  // fetches and bounds them with platformFetch timeouts, so a 20-model save
  // costs one slow fetch, not twenty in sequence.
  const results = await Promise.all(
    models.map(async (model) => {
      const live = await lookupLive(args.kind, args.provider, model);
      if (hasAnyPrice(live)) {
        const existing = await findModelPrice(args.kind, args.provider, model, {
          exactProviderOnly: true,
        });
        const merged: UpsertModelPriceInput = {
          kind: args.kind,
          // Update the existing row in place (its stored casing/spelling)
          // rather than creating a near-duplicate under a differently-cased
          // key; findModelPrice matches case-insensitively.
          provider: existing?.provider ?? args.provider,
          model: existing?.model ?? model,
          inputUsdPerMtok: live.inputUsdPerMtok ?? existing?.inputUsdPerMtok ?? null,
          outputUsdPerMtok: live.outputUsdPerMtok ?? existing?.outputUsdPerMtok ?? null,
          usdPerImage: live.usdPerImage ?? existing?.usdPerImage ?? null,
          usdPerSecond: live.usdPerSecond ?? existing?.usdPerSecond ?? null,
          usdPerVideo: live.usdPerVideo ?? existing?.usdPerVideo ?? null,
        };
        await upsertModelPrice(merged);
        return null;
      }
      // No live price — a manually maintained row (any provider) still counts.
      const manual = await findModelPrice(args.kind, args.provider, model);
      return manual ? null : model;
    }),
  );
  return { missing: results.filter((m): m is string => m !== null) };
}

/**
 * Best-effort price sync (no gate) for models that can serve at runtime
 * without an explicit admin pick — e.g. every provider default when image
 * routing is set to "auto". Catalog hits land in ai_model_prices; models
 * without catalog coverage are simply left for manual entry, because
 * refusing "auto" until every builtin provider is hand-priced would make it
 * unusable. Never throws.
 */
export async function syncModelPricingBestEffort(
  entries: Array<{ kind: PricedKind; provider: string; model: string }>,
): Promise<void> {
  try {
    await Promise.all(
      entries.map((e) =>
        syncActivatedModelPricing({ kind: e.kind, provider: e.provider, models: [e.model] }),
      ),
    );
  } catch {
    // Best-effort by contract.
  }
}

/** One unpriceable model, described precisely enough to fix. */
export interface MissingPricingEntry {
  model: string;
  kind: PricedKind;
  /** For video, which engine the model serves. */
  engine?: "text-to-video" | "image-to-video";
}

/**
 * Standard 400 message for unpriceable models. Names each missing model with
 * its kind (and, for video, the engine) so the admin knows exactly which row
 * to add in the Actual AI cost tracking card.
 */
export function missingPricingError(missing: MissingPricingEntry[]): string {
  const list = missing
    .map((m) => `"${m.model}" (${m.kind}${m.engine ? `, ${m.engine} engine` : ""})`)
    .join(", ");
  return `No pricing found for ${list}. The provider does not publish a price for ${
    missing.length === 1 ? "this model" : "these models"
  }, so add ${
    missing.length === 1 ? "it" : "each one"
  } manually in the Actual AI cost tracking card (using the exact model ID shown) before activating.`;
}
