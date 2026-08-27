import {
  canonicalVideoVariantKey,
  findModelPrice,
  pruneModelPriceVariants,
  upsertModelPrice,
} from "./aiCost";
import {
  lookupReplicatePricing,
  lookupReplicateUnitPricing,
  type PriceEntry,
} from "./replicateCatalog";
import { VIDEO_MODEL_CATALOG } from "./videoGen/modelCatalog";
import { LIP_SYNC_MODELS } from "./videoGen/lipSyncModels";
import { getVideoGenSelection } from "./videoGen";

/**
 * Replicate applies these documented resolutions when callers omit the
 * resolution field. Legacy jobs did exactly that, so retain an explicit
 * inputMode-only variant at the matching official rate for their lookup.
 */
const OMITTED_RESOLUTION_DEFAULTS: Readonly<Record<string, string>> = {
  "wan-video/wan-2.2-t2v-fast": "480p",
  "wan-video/wan-2.2-i2v-fast": "480p",
};

export interface ReplicateVideoPricingTarget {
  model: string;
  label: string;
  uses: string[];
}

/**
 * One deduplicated inventory for every Replicate video model KOKAO can invoke.
 * Text/image modes may share a slug; the price catalog must not create two
 * rows for that. Fixed lip-sync routes are included even though they do not
 * appear in the tenant's generation-model picker.
 */
export function listReplicateVideoPricingTargets(
  activeOverrides: readonly string[] = [],
): ReplicateVideoPricingTarget[] {
  const targets = new Map<string, ReplicateVideoPricingTarget>();
  for (const def of VIDEO_MODEL_CATALOG) {
    if (def.provider !== "replicate") continue;
    for (const mode of ["text", "image"] as const) {
      const model = def.models[mode];
      if (!model) continue;
      const current = targets.get(model) ?? { model, label: def.label, uses: [] };
      const use = mode === "text" ? "Text to Video" : "Animate Photo";
      if (!current.uses.includes(use)) current.uses.push(use);
      targets.set(model, current);
    }
  }
  for (const def of LIP_SYNC_MODELS) {
    const current = targets.get(def.model) ?? { model: def.model, label: def.label, uses: [] };
    if (!current.uses.includes("Lip Sync")) current.uses.push("Lip Sync");
    targets.set(def.model, current);
  }
  for (const raw of activeOverrides) {
    const model = raw.trim();
    if (!model) continue;
    const current = targets.get(model) ?? { model, label: model, uses: [] };
    if (!current.uses.includes("Active admin override")) {
      current.uses.push("Active admin override");
    }
    targets.set(model, current);
  }
  return [...targets.values()];
}

export interface ReplicateVideoPricingSyncResult {
  synced: string[];
  manual: string[];
  unavailable: string[];
}

function dollars(price: string): number | null {
  const value = Number(price.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function videoUnits(entry: PriceEntry): Pick<
  Parameters<typeof upsertModelPrice>[0],
  "usdPerSecond" | "usdPerVideo"
> | null {
  const value = dollars(entry.price);
  if (value === null) return null;
  if (/per second/i.test(entry.title)) return { usdPerSecond: value, usdPerVideo: null };
  if (/per (?:output )?video(?! second)|per run/i.test(entry.title)) {
    return { usdPerSecond: null, usdPerVideo: value };
  }
  return null;
}

/**
 * Refresh every Replicate video price from Replicate's own public model page.
 * A failed/empty provider lookup never overwrites an existing row and never
 * invents a fallback rate. Existing manual rows are reported separately.
 */
export async function syncReplicateVideoPricing(): Promise<ReplicateVideoPricingSyncResult> {
  const selection = await getVideoGenSelection();
  const activeOverrides =
    selection.provider === "replicate"
      ? [selection.textToVideoModel, selection.imageToVideoModel].filter(
          (model): model is string => Boolean(model),
        )
      : [];
  const models = listReplicateVideoPricingTargets(activeOverrides).map((target) => target.model);
  const looked = await lookupReplicateUnitPricing(models);
  const synced: string[] = [];
  const manual: string[] = [];
  const unavailable: string[] = [];

  for (const price of looked) {
    // Do not collapse page variants to the conservative max fields. Each
    // published entry gets its own criteria-aware row (e.g. Seedance
    // resolution + video/non-video input).
    const published = price.entries
      .map((entry) => ({ entry, units: videoUnits(entry) }))
      .filter(
        (item): item is { entry: PriceEntry; units: NonNullable<ReturnType<typeof videoUnits>> } =>
          item.units !== null,
      );
    if (published.length > 0) {
      const existing = await findModelPrice("video", "replicate", price.model, {
        exactProviderOnly: true,
      });
      for (const { entry, units } of published) {
        // aiCost's variant-aware upsert identifies rows by these criteria; do
        // not omit them, or different published rates would collapse.
        await upsertModelPrice({
          kind: "video",
          provider: existing?.provider ?? "replicate",
          model: existing?.model ?? price.model,
          inputUsdPerMtok: existing?.inputUsdPerMtok ?? null,
          outputUsdPerMtok: existing?.outputUsdPerMtok ?? null,
          usdPerImage: existing?.usdPerImage ?? null,
          ...units,
          variantCriteria: entry.criteria,
        });
      }
      const defaultResolution = OMITTED_RESOLUTION_DEFAULTS[price.model];
      const providerDefault = defaultResolution
        ? published.find(({ entry }) => entry.criteria?.resolution === defaultResolution)
        : undefined;
      if (providerDefault) {
        await upsertModelPrice({
          kind: "video",
          provider: existing?.provider ?? "replicate",
          model: existing?.model ?? price.model,
          inputUsdPerMtok: existing?.inputUsdPerMtok ?? null,
          outputUsdPerMtok: existing?.outputUsdPerMtok ?? null,
          usdPerImage: existing?.usdPerImage ?? null,
          ...providerDefault.units,
          variantCriteria: { inputMode: "non_video" },
        });
      }
      // A successful official lookup is authoritative. Remove conditional
      // provider variants that are no longer published so an obsolete tariff
      // cannot remain selectable after Replicate changes its pricing table.
      const publishedKeys = [
        ...new Set(
          [
            ...published.map(({ entry }) => canonicalVideoVariantKey(entry.criteria)),
            ...(providerDefault
              ? [canonicalVideoVariantKey({ inputMode: "non_video" })]
              : []),
          ].filter(Boolean),
        ),
      ];
      await pruneModelPriceVariants({
        kind: "video",
        provider: "replicate",
        model: price.model,
        keepVariantKeys: publishedKeys,
      });
      synced.push(price.model);
      continue;
    }
    const existing = await findModelPrice("video", "replicate", price.model, {
      exactProviderOnly: true,
    });
    if (existing && (existing.usdPerSecond !== null || existing.usdPerVideo !== null)) {
      manual.push(price.model);
    } else {
      unavailable.push(price.model);
    }
  }
  return { synced, manual, unavailable };
}

export async function listReplicateVideoPricing() {
  const targets = listReplicateVideoPricingTargets();
  const prices = await lookupReplicatePricing(targets.map((target) => target.model));
  const priceByModel = new Map(prices.map((price) => [price.model, price.price]));
  return targets.map((target) => ({ ...target, price: priceByModel.get(target.model) ?? null }));
}