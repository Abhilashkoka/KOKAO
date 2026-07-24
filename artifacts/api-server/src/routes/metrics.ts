import { Router, type IRouter, type Request, type Response } from "express";
import { db, postMetricsTable, type PostMetricsRow } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

export function serializePostMetrics(m: PostMetricsRow) {
  return {
    id: m.id,
    contentItemId: m.contentItemId,
    platform: m.platform,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    impressions: m.impressions,
    publishedAt: m.publishedAt.toISOString(),
    fetchedAt: m.fetchedAt ? m.fetchedAt.toISOString() : null,
    pollState: m.pollState,
    failureReason: m.failureReason ?? null,
  };
}

router.get("/metrics/summary", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(postMetricsTable)
    .where(eq(postMetricsTable.tenantId, req.tenantId))
    .orderBy(desc(postMetricsTable.publishedAt));
  res.json(rows.map(serializePostMetrics));
});

export default router;
