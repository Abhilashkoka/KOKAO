import { db, aiSpendSettingsTable, usageEventsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Platform-wide "AI amount spent" display settings.
 *
 * Superadmins configure a base AI cost per caption and per image (in paise)
 * plus a platform fee percentage. Tenants only ever see ONE combined number
 * labeled "AI amount spent" — the fee is folded in, never itemized.
 * No row = everything zero (nothing is shown until the admin sets rates).
 */
export type AiSpendDisplayMode = "flat" | "cost_plus";

export type AiSpendConfig = {
  captionCostPaise: number;
  imageCostPaise: number;
  videoCostPaise: number;
  feePercent: number;
  /**
   * How each usage event's display amount is derived:
   * - "flat": per-kind base cost + fee (historical behavior).
   * - "cost_plus": actual provider cost x (1 + marginPercent/100), falling
   *   back to the flat rate for that kind when the cost is unknown.
   */
  displayMode: AiSpendDisplayMode;
  /** Whole-number percentage margin applied on top of actual cost. */
  marginPercent: number;
};

const DEFAULTS: AiSpendConfig = {
  captionCostPaise: 0,
  imageCostPaise: 0,
  videoCostPaise: 0,
  feePercent: 0,
  displayMode: "flat",
  marginPercent: 0,
};

export async function getAiSpendConfig(): Promise<AiSpendConfig> {
  const [row] = await db.select().from(aiSpendSettingsTable).limit(1);
  if (!row) return { ...DEFAULTS };
  return {
    captionCostPaise: row.captionCostPaise,
    imageCostPaise: row.imageCostPaise,
    videoCostPaise: row.videoCostPaise,
    feePercent: row.feePercent,
    displayMode: row.displayMode,
    marginPercent: row.marginPercent,
  };
}

/** Input shape: mode/margin default to the historical flat behavior. */
export type AiSpendConfigInput = Omit<AiSpendConfig, "displayMode" | "marginPercent"> &
  Partial<Pick<AiSpendConfig, "displayMode" | "marginPercent">>;

export async function setAiSpendConfig(input: AiSpendConfigInput): Promise<AiSpendConfig> {
  const config: AiSpendConfig = {
    ...input,
    displayMode: input.displayMode ?? "flat",
    marginPercent: input.marginPercent ?? 0,
  };
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(aiSpendSettingsTable).limit(1);
    if (existing) {
      // Freeze legacy usage rows (predating per-event display snapshots) at
      // the OUTGOING rates before they change, so historical spend figures
      // never silently shift when a superadmin edits the display rates.
      // Rows written after snapshotting was introduced already carry their
      // own display_paise and are untouched.
      const oldRates = {
        caption: withFee(existing.captionCostPaise, existing.feePercent),
        image: withFee(existing.imageCostPaise, existing.feePercent),
        video: withFee(existing.videoCostPaise, existing.feePercent),
      };
      for (const kind of ["caption", "image", "video"] as const) {
        await tx
          .update(usageEventsTable)
          .set({ displayPaise: oldRates[kind] })
          .where(
            and(eq(usageEventsTable.kind, kind), isNull(usageEventsTable.displayPaise)),
          );
      }
      await tx.update(aiSpendSettingsTable).set(config);
    } else {
      // First-time configuration: leave legacy rows unsnapshotted so the
      // newly set rates apply retroactively (there were no prior rates to
      // preserve — the zero defaults were just "not configured yet").
      await tx.insert(aiSpendSettingsTable).values(config);
    }
  });
  return getAiSpendConfig();
}

/** Fold the platform fee into a base cost, rounding to whole paise. */
export function withFee(basePaise: number, feePercent: number): number {
  return Math.round(basePaise * (1 + feePercent / 100));
}

/** The effective flat display rate for one kind (fee folded in). */
export function flatDisplayPaise(
  kind: "caption" | "image" | "video",
  config: AiSpendConfig,
): number {
  const base =
    kind === "caption"
      ? config.captionCostPaise
      : kind === "image"
        ? config.imageCostPaise
        : config.videoCostPaise;
  return withFee(base, config.feePercent);
}

/**
 * The tenant-facing display amount for one usage event, snapshotted at
 * recording time.
 *
 * - flat mode: the per-kind rate with the fee folded in (cost is ignored).
 * - cost_plus mode: actual cost x (1 + marginPercent/100). When the actual
 *   cost is unknown (null), the flat rate for that kind is the DEFINED
 *   fallback — the displayed amount is never blank or silently guessed.
 */
export function computeDisplayPaise(
  kind: "caption" | "image" | "video",
  costPaise: number | null,
  config: AiSpendConfig,
): number {
  if (config.displayMode === "cost_plus" && costPaise !== null) {
    return Math.round(costPaise * (1 + config.marginPercent / 100));
  }
  return flatDisplayPaise(kind, config);
}

/** The per-unit amounts tenants see (fee already included). */
export async function getAiSpendRates(): Promise<{
  captionPaise: number;
  imagePaise: number;
  videoPaise: number;
}> {
  const config = await getAiSpendConfig();
  return {
    captionPaise: withFee(config.captionCostPaise, config.feePercent),
    imagePaise: withFee(config.imageCostPaise, config.feePercent),
    videoPaise: withFee(config.videoCostPaise, config.feePercent),
  };
}
