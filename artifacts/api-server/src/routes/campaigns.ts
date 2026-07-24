import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  campaignsTable,
  contentItemsTable,
  postMetricsTable,
  type Campaign,
} from "@workspace/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import { CreateCampaignBody, UpdateCampaignBody } from "@workspace/api-zod";
import { serializePostMetrics } from "./metrics";

const router: IRouter = Router();

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

function serializeCampaign(c: Campaign, contentCount = 0) {
  return {
    id: c.id,
    name: c.name,
    goal: c.goal,
    goalTarget: c.goalTarget ?? null,
    description: c.description ?? null,
    status: c.status,
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    contentCount,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function loadCampaign(
  id: number,
  tenantId: number,
): Promise<Campaign | undefined> {
  return (
    await db
      .select()
      .from(campaignsTable)
      .where(and(eq(campaignsTable.id, id), eq(campaignsTable.tenantId, tenantId)))
      .limit(1)
  )[0];
}

/** startsAt/endsAt must be a coherent window when both are set. */
function datesValid(
  startsAt?: string | Date | null,
  endsAt?: string | Date | null,
): boolean {
  if (startsAt && Number.isNaN(new Date(startsAt).getTime())) return false;
  if (endsAt && Number.isNaN(new Date(endsAt).getTime())) return false;
  if (startsAt && endsAt && new Date(startsAt) > new Date(endsAt)) return false;
  return true;
}

router.get("/campaigns", async (req: Request, res: Response) => {
  const rows = await db
    .select({
      campaign: campaignsTable,
      contentCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${contentItemsTable}
        WHERE ${contentItemsTable.campaignId} = ${campaignsTable.id}
      )`,
    })
    .from(campaignsTable)
    .where(eq(campaignsTable.tenantId, req.tenantId))
    .orderBy(sql`${campaignsTable.createdAt} DESC`);
  res.json(rows.map((r) => serializeCampaign(r.campaign, r.contentCount)));
});

router.post("/campaigns", async (req: Request, res: Response) => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { name, goal, goalTarget, description, startsAt, endsAt } = parsed.data;
  if (!datesValid(startsAt, endsAt)) {
    res.status(400).json({ error: "Start date must be before end date" });
    return;
  }
  const created = (
    await db
      .insert(campaignsTable)
      .values({
        tenantId: req.tenantId,
        name: name.trim(),
        goal: goal?.trim() || "engagement",
        goalTarget: goalTarget ?? null,
        description: description?.trim() || null,
        startsAt: startsAt ? new Date(startsAt) : null,
        endsAt: endsAt ? new Date(endsAt) : null,
      })
      .returning()
  )[0]!;
  res.status(201).json(serializeCampaign(created));
});

router.get("/campaigns/:id", async (req: Request, res: Response) => {
  const campaign = await loadCampaign(Number(req.params.id), req.tenantId);
  if (!campaign) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const count = (
    await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(contentItemsTable)
      .where(eq(contentItemsTable.campaignId, campaign.id))
  )[0];
  res.json(serializeCampaign(campaign, count?.n ?? 0));
});

router.patch("/campaigns/:id", async (req: Request, res: Response) => {
  const parsed = UpdateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const existing = await loadCampaign(Number(req.params.id), req.tenantId);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, goal, goalTarget, description, status, startsAt, endsAt } =
    parsed.data;
  const nextStarts =
    startsAt !== undefined
      ? startsAt
      : existing.startsAt?.toISOString() ?? null;
  const nextEnds =
    endsAt !== undefined ? endsAt : existing.endsAt?.toISOString() ?? null;
  if (!datesValid(nextStarts, nextEnds)) {
    res.status(400).json({ error: "Start date must be before end date" });
    return;
  }
  const updated = (
    await db
      .update(campaignsTable)
      .set({
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(goal !== undefined ? { goal: goal.trim() || "engagement" } : {}),
        ...(goalTarget !== undefined ? { goalTarget: goalTarget ?? null } : {}),
        ...(description !== undefined
          ? { description: description?.trim() || null }
          : {}),
        ...(status !== undefined ? { status } : {}),
        ...(startsAt !== undefined
          ? { startsAt: startsAt ? new Date(startsAt) : null }
          : {}),
        ...(endsAt !== undefined
          ? { endsAt: endsAt ? new Date(endsAt) : null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaignsTable.id, existing.id),
          eq(campaignsTable.tenantId, req.tenantId),
        ),
      )
      .returning()
  )[0]!;
  const count = (
    await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(contentItemsTable)
      .where(eq(contentItemsTable.campaignId, updated.id))
  )[0];
  res.json(serializeCampaign(updated, count?.n ?? 0));
});

router.delete("/campaigns/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  // Detach items first, then delete — one transaction so a failure can't
  // leave items pointing at a deleted campaign.
  const deleted = await db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ id: campaignsTable.id })
        .from(campaignsTable)
        .where(and(eq(campaignsTable.id, id), eq(campaignsTable.tenantId, req.tenantId)))
        .limit(1)
    )[0];
    if (!row) return false;
    await tx
      .update(contentItemsTable)
      .set({ campaignId: null })
      .where(
        and(
          eq(contentItemsTable.campaignId, id),
          eq(contentItemsTable.tenantId, req.tenantId),
        ),
      );
    await tx.delete(campaignsTable).where(eq(campaignsTable.id, id));
    return true;
  });
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

router.get("/campaigns/:id/report", async (req: Request, res: Response) => {
  const campaign = await loadCampaign(Number(req.params.id), req.tenantId);
  if (!campaign) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const items = await db
    .select({
      id: contentItemsTable.id,
      title: contentItemsTable.title,
      status: contentItemsTable.status,
    })
    .from(contentItemsTable)
    .where(
      and(
        eq(contentItemsTable.campaignId, campaign.id),
        eq(contentItemsTable.tenantId, req.tenantId),
      ),
    )
    .orderBy(sql`${contentItemsTable.createdAt} DESC`);

  const itemIds = items.map((i) => i.id);
  const metricRows = itemIds.length
    ? await db
        .select()
        .from(postMetricsTable)
        .where(
          and(
            eq(postMetricsTable.tenantId, req.tenantId),
            inArray(postMetricsTable.contentItemId, itemIds),
          ),
        )
    : [];

  const byItem = new Map<number, typeof metricRows>();
  const totals = {
    likes: 0,
    comments: 0,
    shares: 0,
    impressions: 0,
    engagements: 0,
    trackedPosts: 0,
  };
  for (const m of metricRows) {
    const list = byItem.get(m.contentItemId) ?? [];
    list.push(m);
    byItem.set(m.contentItemId, list);
    totals.likes += m.likes;
    totals.comments += m.comments;
    totals.shares += m.shares;
    totals.impressions += m.impressions;
    totals.trackedPosts += 1;
  }
  totals.engagements = totals.likes + totals.comments + totals.shares;

  res.json({
    campaign: serializeCampaign(campaign, items.length),
    totals,
    items: items.map((i) => ({
      contentItemId: i.id,
      title: i.title,
      status: i.status,
      metrics: (byItem.get(i.id) ?? []).map(serializePostMetrics),
    })),
  });
});

export default router;
