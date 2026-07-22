import { db, usageEventsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";

export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getUsage(
  tenantId: number,
): Promise<{ captions: number; images: number; periodStart: Date }> {
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
  return { captions, images, periodStart };
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
}

export async function recordUsage(
  tenantId: number,
  kind: "caption" | "image",
  meta: UsageMeta = {},
): Promise<void> {
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
  });
}
