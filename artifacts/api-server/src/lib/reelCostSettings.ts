import { adminAuditLogsTable, db, reelCostSettingsTable, type ReelCostSettings } from "@workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { logger } from "./logger";

export type TryOnImageQuality = "auto" | "low" | "medium" | "high";

export interface ReelCostSettingsView {
  tryOnImageQuality: TryOnImageQuality;
  reelResolution: "480p" | "720p" | "1080p";
  defaultBars: number;
  heroModeEnabled: boolean;
  defaultReelStyle: "video" | "hero" | "photo";
  updatedAt: string | null;
  updatedBy: string | null;
}

export const REEL_COST_AUDIT_ACTION = "reel_cost_settings_change";

/** The cost-saving defaults used until an admin saves anything. */
export const DEFAULT_REEL_COST_SETTINGS: ReelCostSettingsView = {
  tryOnImageQuality: "medium",
  reelResolution: "720p",
  defaultBars: 1,
  heroModeEnabled: true,
  defaultReelStyle: "hero",
  updatedAt: null,
  updatedBy: null,
};

const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

function view(row: ReelCostSettings | undefined): ReelCostSettingsView {
  if (!row) return DEFAULT_REEL_COST_SETTINGS;
  const d = DEFAULT_REEL_COST_SETTINGS;
  const heroModeEnabled = row.heroModeEnabled;
  const style = pick(row.defaultReelStyle, ["video", "hero", "photo"] as const, d.defaultReelStyle);
  return {
    tryOnImageQuality: pick(row.tryOnImageQuality, ["auto", "low", "medium", "high"] as const, d.tryOnImageQuality),
    reelResolution: pick(row.reelResolution, ["480p", "720p", "1080p"] as const, d.reelResolution),
    defaultBars: Math.min(3, Math.max(1, row.defaultBars)),
    heroModeEnabled,
    // A disabled hero mode can never be the default.
    defaultReelStyle: style === "hero" && !heroModeEnabled ? "video" : style,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/**
 * The current settings. Fail-open to the defaults (a missing table before the
 * SQL file is run, or a read error, must never break reels).
 */
export async function getReelCostSettings(): Promise<ReelCostSettingsView> {
  try {
    const [row] = await db
      .select()
      .from(reelCostSettingsTable)
      .orderBy(asc(reelCostSettingsTable.id))
      .limit(1);
    return view(row);
  } catch (err) {
    logger.warn({ err }, "Reel cost settings unavailable; using defaults");
    return DEFAULT_REEL_COST_SETTINGS;
  }
}

export async function saveReelCostSettings(
  input: Omit<ReelCostSettingsView, "updatedAt" | "updatedBy">,
  updatedBy: string | null,
): Promise<ReelCostSettingsView> {
  const [existing] = await db
    .select()
    .from(reelCostSettingsTable)
    .orderBy(asc(reelCostSettingsTable.id))
    .limit(1);
  const values = { ...input, updatedBy };
  if (existing) {
    const [row] = await db
      .update(reelCostSettingsTable)
      .set(values)
      .where(eq(reelCostSettingsTable.id, existing.id))
      .returning();
    return view(row);
  }
  const [row] = await db.insert(reelCostSettingsTable).values(values).returning();
  return view(row);
}

/** The last changes, newest first, from the admin audit log. */
export async function reelCostSettingsHistory(limit = 15) {
  const rows = await db
    .select()
    .from(adminAuditLogsTable)
    .where(eq(adminAuditLogsTable.action, REEL_COST_AUDIT_ACTION))
    .orderBy(desc(adminAuditLogsTable.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    at: r.createdAt.toISOString(),
    by: r.actorEmail,
    from: r.oldValue,
    to: r.newValue,
  }));
}
