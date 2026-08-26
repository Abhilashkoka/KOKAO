import { findModelPrice, upsertModelPrice } from "./aiCost";
import { lookupReplicatePricing, lookupReplicateUnitPricing } from "./replicateCatalog";
import { VIDEO_MODEL_CATALOG } from "./videoGen/modelCatalog";
import { LIP_SYNC_MODELS } from "./videoGen/lipSyncModels";
import { getVideoGenSelection } from "./videoGen";

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
    if (
      price.usdPerSecond !== null ||
      price.usdPerVideo !== null
    ) {
      const existing = await findModelPrice("video", "replicate", price.model, {
        exactProviderOnly: true,
      });
      await upsertModelPrice({
        kind: "video",
        provider: existing?.provider ?? "replicate",
        model: existing?.model ?? price.model,
        inputUsdPerMtok: existing?.inputUsdPerMtok ?? null,
        outputUsdPerMtok: existing?.outputUsdPerMtok ?? null,
        usdPerImage: existing?.usdPerImage ?? null,
        usdPerSecond: price.usdPerSecond,
        usdPerVideo: price.usdPerVideo,
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