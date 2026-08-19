import { db, usageEventsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { computeDisplayPaise, getAiSpendConfig } from "./aiSpend";

export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getUsage(
  tenantId: number,
): Promise<{ captions: number; images: number; videos: number; periodStart: Date }> {
  const periodStart = currentPeriodStart();
  const rows = await db
    .select({
      kind: usageEventsTable.kind,
      count: sql<number>`count(*)::int`,
    })
    .from(usageEventsTable)
    .where(
      and(
        eq(usageEventsTable.tenantId, tenantId),
        gte(usageEventsTable.createdAt, periodStart),
        // Credit-, wallet-, and explicitly unmetered rows exist only for
        // data-consumption/cost telemetry and must never count against the
        // monthly plan quota.
        sql`(${usageEventsTable.funding} IS DISTINCT FROM 'credit' AND ${usageEventsTable.funding} IS DISTINCT FROM 'wallet' AND ${usageEventsTable.funding} IS DISTINCT FROM 'unmetered')`,
      ),
    )
    .groupBy(usageEventsTable.kind);

  const captions = rows.find((r) => r.kind === "caption")?.count ?? 0;
  const images = rows.find((r) => r.kind === "image")?.count ?? 0;
  const videos = rows.find((r) => r.kind === "video")?.count ?? 0;
  return { captions, images, videos, periodStart };
}

/** Optional AI data-consumption metrics attached to a usage row. */
export interface UsageMeta {
  requestBytes?: number;
  responseBytes?: number;
  durationMs?: number;
  model?: string;
  campaignId?: string;
  platform?: string;
  funding?: "quota" | "credit" | "wallet" | "unmetered";
  // Actual-cost tracking (superadmin-only reporting; best-effort).
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  costPaise?: number;
  // Richer telemetry (best-effort; omitted rather than zeroed when unknown).
  // cachedInputTokens/reasoningTokens are SUBSETS of inputTokens/outputTokens.
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** Time to first token, streaming text only. */
  ttftMs?: number;
  /** 0 = the first provider tried, 1 = the first fallback, and so on. */
  fallbackStep?: number;
  /** Human-readable "why this provider"; for debugging, never parsed. */
  routingReason?: string;
  /**
   * Precomputed display snapshot (paise). Job runners that must persist the
   * spend on the job row BEFORE flipping it to a terminal status pass the
   * value they already computed here, so the usage event and the job row can
   * never disagree. Undefined = compute from the current config as usual.
   */
  displayPaiseOverride?: number | null;
}

/**
 * Insert one usage event and return the snapshotted tenant-facing display
 * amount (paise) it recorded, so callers can surface the REAL per-event
 * spend to the client instead of re-deriving it from the flat rates.
 * Returns null when no snapshot could be computed.
 */
export async function recordUsage(
  tenantId: number,
  kind: "caption" | "image" | "video",
  meta: UsageMeta = {},
): Promise<number | null> {
  // Snapshot the tenant-facing display amount at the settings in effect
  // RIGHT NOW, so later rate/margin changes never rewrite historical spend
  // figures. In flat mode this is the per-kind rate; in cost_plus mode it is
  // actual cost x (1 + margin%), falling back to the flat rate when the cost
  // is unknown. Best-effort: a failed lookup stores NULL (reports fall back
  // to current rates for such rows) and must never block the metered action.
  let displayPaise: number | null = null;
  if (meta.displayPaiseOverride !== undefined) {
    displayPaise = meta.displayPaiseOverride;
  } else {
    try {
      const config = await getAiSpendConfig();
      displayPaise = computeDisplayPaise(kind, meta.costPaise ?? null, config);
    } catch {
      displayPaise = null;
    }
  }
  await db.insert(usageEventsTable).values({
    tenantId,
    kind,
    requestBytes: meta.requestBytes ?? null,
    responseBytes: meta.responseBytes ?? null,
    durationMs: meta.durationMs ?? null,
    model: meta.model ?? null,
    campaignId: meta.campaignId ?? null,
    platform: meta.platform ?? null,
    funding: meta.funding ?? null,
    provider: meta.provider ?? null,
    inputTokens: meta.inputTokens ?? null,
    outputTokens: meta.outputTokens ?? null,
    costPaise: meta.costPaise ?? null,
    cachedInputTokens: meta.cachedInputTokens ?? null,
    reasoningTokens: meta.reasoningTokens ?? null,
    ttftMs: meta.ttftMs ?? null,
    fallbackStep: meta.fallbackStep ?? null,
    routingReason: meta.routingReason ?? null,
    displayPaise,
  });
  return displayPaise;
}
