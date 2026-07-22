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
export type AiSpendConfig = {
  captionCostPaise: number;
  imageCostPaise: number;
  feePercent: number;
};

const DEFAULTS: AiSpendConfig = { captionCostPaise: 0, imageCostPaise: 0, feePercent: 0 };

export async function getAiSpendConfig(): Promise<AiSpendConfig> {
  const [row] = await db.select().from(aiSpendSettingsTable).limit(1);
  if (!row) return { ...DEFAULTS };
  return {
    captionCostPaise: row.captionCostPaise,
    imageCostPaise: row.imageCostPaise,
    feePercent: row.feePercent,
  };
}

export async function setAiSpendConfig(config: AiSpendConfig): Promise<AiSpendConfig> {
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
      };
      for (const kind of ["caption", "image"] as const) {
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

/** The per-unit amounts tenants see (fee already included). */
export async function getAiSpendRates(): Promise<{ captionPaise: number; imagePaise: number }> {
  const config = await getAiSpendConfig();
  return {
    captionPaise: withFee(config.captionCostPaise, config.feePercent),
    imagePaise: withFee(config.imageCostPaise, config.feePercent),
  };
}
