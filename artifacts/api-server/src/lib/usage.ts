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
      ),
    )
    .groupBy(usageEventsTable.kind);

  const captions = rows.find((r) => r.kind === "caption")?.count ?? 0;
  const images = rows.find((r) => r.kind === "image")?.count ?? 0;
  return { captions, images, periodStart };
}

export async function recordUsage(
  tenantId: number,
  kind: "caption" | "image",
): Promise<void> {
  await db.insert(usageEventsTable).values({ tenantId, kind });
}
