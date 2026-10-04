import { describe, it, expect, vi, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { db, pool, scheduledPostsTable, contentItemsTable, videoPublishesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
vi.mock("../lib/tasteMemory", () => ({ recordTasteSignal: vi.fn() }));
vi.mock("../lib/scheduledPublisher", () => ({ retryScheduledPostNow: vi.fn() }));
import router from "./schedules";
afterAll(() => pool.end());
describe("native schedule cancellation boundary", () => {
  it.each(["queued", "processing"])("refuses cancellation/removal of a %s upload, including permission-paused work", async state => {
    const tenant = await createTenant();
    const app = express().use(express.json()).use((req, _res, next) => { req.tenantId = tenant.tenantId; next(); }).use(router);
    try {
      const [item] = await db.insert(contentItemsTable).values({ tenantId: tenant.tenantId, title: "Video", caption: "" }).returning();
      const metadata = { destination: "youtube", format: "video", title: "Review", description: "", privacy: "private", madeForKids: false } as const;
      const [schedule] = await db.insert(scheduledPostsTable).values({ tenantId: tenant.tenantId, contentItemId: item.id, platform: "youtube", scheduledAt: new Date(), status: "processing", videoSnapshot: { videoPath: "/unused", metadata } }).returning();
      await db.insert(videoPublishesTable).values({ tenantId: tenant.tenantId, contentItemId: item.id, platform: "youtube", videoPath: "/unused", metadata, state, error: "Reconnect" });
      expect((await request(app).patch(`/schedules/${schedule.id}`).send({ status: "cancelled" })).status).toBe(409);
      expect((await request(app).delete(`/schedules/${schedule.id}`)).status).toBe(409);
      const [saved] = await db.select().from(scheduledPostsTable).where(eq(scheduledPostsTable.id, schedule.id));
      expect(saved.status).toBe("processing");
      // After a terminal result there is no active upload to cancel, so removal is allowed.
      await db.update(videoPublishesTable).set({ state: "failed" }).where(eq(videoPublishesTable.contentItemId, item.id));
      await db.update(scheduledPostsTable).set({ status: "failed" }).where(eq(scheduledPostsTable.id, schedule.id));
      expect((await request(app).delete(`/schedules/${schedule.id}`)).status).toBe(204);
    } finally {
      await db.delete(videoPublishesTable).where(eq(videoPublishesTable.tenantId, tenant.tenantId));
      await deleteTenant(tenant.tenantId);
    }
  });
});