import { db, usageEventsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { getAiSpendRates } from "./aiSpend";

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
        // Credit-funded rows exist only for data-consumption metering and
        // must never count against the monthly plan quota.
        sql`${usageEventsTable.funding} IS DISTINCT FROM 'credit'`,
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
  funding?: "quota" | "credit";
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
}

export async function recordUsage(
  tenantId: number,
  kind: "caption" | "image" | "video",
  meta: UsageMeta = {},
): Promise<void> {
  // Snapshot the tenant-facing per-unit display amount at the rates in effect
  // RIGHT NOW, so later rate changes never rewrite historical spend figures.
  // Best-effort: a failed lookup stores NULL (reports fall back to current
  // rates for such rows) and must never block the metered action itself.
  let displayPaise: number | null = null;
  try {
    const rates = await getAiSpendRates();
    displayPaise =
      kind === "caption"
        ? rates.captionPaise
        : kind === "image"
          ? rates.imagePaise
          : rates.videoPaise;
  } catch {
    displayPaise = null;
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
}
