import {
  canonicalVideoVariantKey,
  findModelPrice,
  pruneModelPriceVariants,
  upsertModelPrice,
  type UpsertModelPriceInput,
} from "./aiCost";
import { lookupGeminiPricing } from "./geminiCatalog";
import { lookupOpenAiPricing } from "./openaiCatalog";
import { lookupOpenRouterPricing, lookupOpenRouterVideoPricing } from "./openrouterCatalog";
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

function hasSavedPrice(
  kind: PricedKind,
  price: Pick<
    UpsertModelPriceInput,
    "inputUsdPerMtok" | "outputUsdPerMtok" | "usdPerImage" | "usdPerSecond" | "usdPerVideo"
  >,
): boolean {
  if (kind === "text") {
    return price.inputUsdPerMtok !== null || price.outputUsdPerMtok !== null;
  }
  if (kind === "image") {
    return (
      price.usdPerImage !== null ||
      price.inputUsdPerMtok !== null ||
      price.outputUsdPerMtok !== null
    );
  }
  return price.usdPerSecond !== null || price.usdPerVideo !== null;
}

function replicateVideoUnits(entry: {
  price: string;
  title: string;
}): Pick<LookedUpPrices, "usdPerSecond" | "usdPerVideo"> | null {
  const value = Number(entry.price.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value)) return null;
  if (/per second/i.test(entry.title)) {
    return { usdPerSecond: value, usdPerVideo: null };
  }
  if (/per (?:output )?video(?! second)|per run/i.test(entry.title)) {
    return { usdPerSecond: null, usdPerVideo: value };
  }
  return null;
}

/**
 * One public price catalog we know how to query, keyed by the provider whose
 * prices it publishes. Model slugs are shared across marketplaces often
 * enough (e.g. "google/veo-3-fast" exists on both Replicate and OpenRouter)
 * that another catalog is a usable emergency source when the model's own
 * provider blocks or omits the lookup — the admin is warned so they can
 * verify the rate.
 */
type CatalogSource = (kind: PricedKind, model: string) => Promise<LookedUpPrices>;

const CATALOG_SOURCES: ReadonlyArray<{ provider: string; lookup: CatalogSource }> = [
  {
    provider: "openai",
    lookup: async (kind, model) => {
      if (kind === "video") return EMPTY;
      const [p] = await lookupOpenAiPricing([model]);
      return {
        ...EMPTY,
        inputUsdPerMtok: p?.inputPerMTokens ?? null,
        outputUsdPerMtok: p?.outputPerMTokens ?? null,
      };
    },
  },
  {
    provider: "gemini",
    lookup: async (kind, model) => {
      if (kind === "video") return EMPTY;
      const [p] = await lookupGeminiPricing([model]);
      return {
        ...EMPTY,
        inputUsdPerMtok: p?.inputPerMTokens ?? null,
        outputUsdPerMtok: p?.outputPerMTokens ?? null,
        usdPerImage: kind === "image" ? (p?.usdPerImage ?? null) : null,
      };
    },
  },
  {
    provider: "openrouter",
    lookup: async (kind, model) => {
      if (kind === "video") {
        // Video has its own public catalog with per-second SKUs.
        const [v] = await lookupOpenRouterVideoPricing([model]);
        return { ...EMPTY, usdPerSecond: v?.usdPerSecond ?? null };
      }
      const [p] = await lookupOpenRouterPricing([model]);
      // OpenRouter image models bill by tokens; generated images count as
      // image OUTPUT tokens, which have their own (much higher) rate than
      // text completion. Prefer it for the output price when published.
      return {
        ...EMPTY,
        inputUsdPerMtok: p?.inputPerMTokens ?? null,
        outputUsdPerMtok:
          kind === "image"
            ? (p?.imageOutputPerMTokens ?? p?.outputPerMTokens ?? null)
            : (p?.outputPerMTokens ?? null),
      };
    },
  },
  {
    provider: "replicate",
    lookup: async (kind, model) => {
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
    },
  },
];

interface LiveLookupResult {
  prices: LookedUpPrices;
  /** Catalog that actually supplied the price (differs from the model's own provider on failover). */
  source: string | null;
}

/**
 * Live catalog lookup for one model. The model's own provider catalog is
 * always tried first; when it yields nothing (site blocked, price not
 * published), every OTHER known catalog is tried for the same model slug so
 * a blocked provider site doesn't force manual entry when another
 * marketplace publishes the price. `source` records where the price came
 * from; EMPTY/null when no catalog covers it.
 */
async function lookupLive(
  kind: PricedKind,
  provider: string,
  model: string,
): Promise<LiveLookupResult> {
  const normalized = provider.trim().toLowerCase();
  const ordered = [
    ...CATALOG_SOURCES.filter((s) => s.provider === normalized),
    ...CATALOG_SOURCES.filter((s) => s.provider !== normalized),
  ];
  for (const sourceDef of ordered) {
    try {
      const prices = await sourceDef.lookup(kind, model);
      if (hasAnyPrice(prices)) return { prices, source: sourceDef.provider };
    } catch {
      // Fail-soft: a catalog hiccup falls through to the next source, then
      // to the manual-row check.
    }
  }
  return { prices: EMPTY, source: null };
}

export interface PricingSyncResult {
  /** Models that could not be priced (no catalog data, no manual row). */
  missing: string[];
  /**
   * Models whose price came from a DIFFERENT provider's catalog because the
   * model's own provider published nothing (e.g. site blocked). The admin
   * should verify these rates against the actual provider.
   */
  crossSourced: Array<{ model: string; source: string }>;
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
  const crossSourced: Array<{ model: string; source: string }> = [];
  const results = await Promise.all(
    models.map(async (model) => {
      // Replicate video pages can publish conditional tariffs (for example,
      // Veo with/without generated audio). The aggregate lookup below keeps
      // only the conservative maximum and would create a visible generic row
      // that cannot satisfy the variant-aware runtime gate. Persist every
      // official variant instead.
      if (args.kind === "video" && args.provider.trim().toLowerCase() === "replicate") {
        try {
          const [catalog] = await lookupReplicateUnitPricing([model]);
          const published = (catalog?.entries ?? [])
            .map((entry) => ({ entry, units: replicateVideoUnits(entry) }))
            .filter(
              (
                item,
              ): item is {
                entry: (typeof catalog.entries)[number];
                units: NonNullable<ReturnType<typeof replicateVideoUnits>>;
              } => item.units !== null,
            );
          if (published.length > 0) {
            const existing = await findModelPrice("video", args.provider, model, {
              exactProviderOnly: true,
            });
            for (const { entry, units } of published) {
              await upsertModelPrice({
                kind: "video",
                provider: existing?.provider ?? args.provider,
                model: existing?.model ?? model,
                inputUsdPerMtok: null,
                outputUsdPerMtok: null,
                usdPerImage: null,
                ...units,
                variantCriteria: entry.criteria,
              });
            }
            await pruneModelPriceVariants({
              kind: "video",
              provider: args.provider,
              model,
              keepVariantKeys: published.map(({ entry }) =>
                canonicalVideoVariantKey(entry.criteria),
              ),
            });
            return null;
          }
        } catch {
          // Fall through to the normal cross-catalog/manual-row behavior.
        }
      }
      const { prices: live, source } = await lookupLive(args.kind, args.provider, model);
      if (hasAnyPrice(live)) {
        const ownProvider = args.provider.trim().toLowerCase();
        const existing = await findModelPrice(args.kind, args.provider, model, {
          exactProviderOnly: true,
        });
        if (source && source !== ownProvider && existing && hasSavedPrice(args.kind, existing)) {
          // The admin's exact provider/model price is more relevant than a
          // same-named model sold by another marketplace. Keep it untouched
          // and do not show a cross-catalog verification warning.
          return null;
        }
        if (source && source !== ownProvider) {
          crossSourced.push({ model, source });
        }
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
        if (
          args.kind === "video" &&
          source === args.provider.trim().toLowerCase()
        ) {
          // A provider-published model-level video rate supersedes stale
          // manually entered conditional rows for the same provider/model.
          // Leaving both shapes in place makes variant-aware lookup ignore the
          // authoritative generic row and falsely reject activation.
          await pruneModelPriceVariants({
            kind: "video",
            provider: merged.provider,
            model: merged.model,
            keepVariantKeys: [""],
          });
        }
        return null;
      }
      // No live price — a manually maintained row (any provider) still counts.
      const manual = await findModelPrice(args.kind, args.provider, model);
      return manual ? null : model;
    }),
  );
  return { missing: results.filter((m): m is string => m !== null), crossSourced };
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

/**
 * Admin-facing warning when activation succeeded but one or more prices came
 * from another provider's catalog. Null when nothing was cross-sourced.
 */
export function crossSourcePricingWarning(
  provider: string,
  crossSourced: Array<{ model: string; source: string }>,
): string | null {
  if (crossSourced.length === 0) return null;
  const list = crossSourced.map((c) => `"${c.model}" (from the ${c.source} catalog)`).join(", ");
  return `Settings were saved with provisional pricing because ${provider} does not publish a public rate for ${list}. Compare ${
    crossSourced.length === 1 ? "this rate" : "these rates"
  } with your ${provider} bill or documentation. If ${
    crossSourced.length === 1 ? "it matches" : "they match"
  }, no action is needed; otherwise edit the exact ${provider} model ${
    crossSourced.length === 1 ? "price" : "prices"
  } in Actual AI Cost Tracking.`;
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
