import { describe, it, expect, vi, afterAll } from "vitest";
import { db, pool, contentItemsTable, videoPublishesTable, scheduledPostsTable, type VideoPublishMetadata } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
vi.mock("./videoPublishAuth", () => ({ videoPublishAuth: vi.fn(async () => ({ token: "mock", accountId: "mock-channel" })) }));
vi.mock("./videoPublishMedia", () => ({ stageVideo: vi.fn(async (path: string, tenant: number) => {
  if (!path.startsWith(`/objects/${tenant}/`)) throw new Error("Object not found");
  return { cleanup: vi.fn(), size: 12, localPath: "/unused" };
}) }));
vi.mock("./featureFlags", () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock("./compliance/content", () => ({ contentPublishBlock: vi.fn(async () => null) }));
vi.mock("./videoPublishProviders", async importOriginal => {
  const original = await importOriginal<typeof import("./videoPublishProviders")>();
  return { ...original, driveYoutube: vi.fn(async (_row, _token, save) => save({ externalId: "yt-existing", state: "published", permalink: "https://www.youtube.com/watch?v=yt-existing" })) };
});
import { enqueueVideoPublish, runVideoPublishTick } from "./videoPublisher";
import { videoPublishAuth } from "./videoPublishAuth";
import { contentPublishBlock } from "./compliance/content";
const metadata: VideoPublishMetadata = { destination: "youtube", format: "video", title: "Reviewed title", description: "Reviewed description", privacy: "private", madeForKids: false };
afterAll(() => pool.end());
async function fixture() {
  const tenant = await createTenant();
  const [item] = await db.insert(contentItemsTable).values({ tenantId: tenant.tenantId, title: "Original", caption: "Original", videoPath: `/objects/${tenant.tenantId}/video`, videoPublishMetadata: metadata }).returning();
  return { tenantId: tenant.tenantId, item, cleanup: async () => {
    await db.delete(videoPublishesTable).where(eq(videoPublishesTable.tenantId, tenant.tenantId));
    await deleteTenant(tenant.tenantId);
  } };
}
describe("durable native publishing", () => {
  it("checks exact outgoing scheduled copy rather than the current Library text", async () => {
    const f = await fixture();
    try {
      vi.mocked(contentPublishBlock).mockResolvedValueOnce({ ok: false, errorStatus: 422, error: "Blocked outgoing copy" });
      const snapshot = { videoPath: f.item.videoPath!, metadata: { ...metadata, description: "Noncompliant snapshot" } };
      expect(await enqueueVideoPublish(f.tenantId, f.item.id, "youtube", snapshot)).toMatchObject({ ok: false, errorStatus: 422 });
      expect(contentPublishBlock).toHaveBeenLastCalledWith(f.tenantId, f.item.id, { title: metadata.title, caption: "Noncompliant snapshot" });
      expect(await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.contentItemId, f.item.id))).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it("rotates more than ten permission-paused uploads without changing their checkpoint clocks", async () => {
    const f = await fixture();
    const checkpoint = new Date("2026-01-01T00:00:00Z");
    try {
      const items = await db.insert(contentItemsTable).values(Array.from({ length: 12 }, () => ({ tenantId: f.tenantId, title: "Paused", caption: "", videoPath: f.item.videoPath }))).returning();
      await db.insert(videoPublishesTable).values(items.map(item => ({ tenantId: f.tenantId, contentItemId: item.id, platform: "youtube", videoPath: item.videoPath!, metadata, state: "queued", accountId: "mock-channel", updatedAt: checkpoint, lastAttemptAt: checkpoint })));
      vi.mocked(videoPublishAuth).mockRejectedValue(new Error("Reconnect"));
      await runVideoPublishTick();
      await runVideoPublishTick();
      const rows = await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.tenantId, f.tenantId));
      expect(rows).toHaveLength(12);
      expect(rows.every(row => row.lastAttemptAt > checkpoint)).toBe(true);
      expect(rows.every(row => row.updatedAt.getTime() === checkpoint.getTime())).toBe(true);
    } finally {
      vi.mocked(videoPublishAuth).mockResolvedValue({ token: "mock", accountId: "mock-channel" });
      await f.cleanup();
    }
  });
  it("enforces content and object ownership before enqueue", async () => {
    const f = await fixture();
    try {
      expect(await enqueueVideoPublish(f.tenantId + 1, f.item.id, "youtube")).toMatchObject({ ok: false, errorStatus: 404 });
      await db.update(contentItemsTable).set({ videoPath: "/objects/0/foreign" }).where(eq(contentItemsTable.id, f.item.id));
      expect(await enqueueVideoPublish(f.tenantId, f.item.id, "youtube")).toMatchObject({ ok: false, error: "Object not found" });
      expect(await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.contentItemId, f.item.id))).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it("rejects missing upload authorization", async () => {
    const f = await fixture();
    try {
      vi.mocked(videoPublishAuth).mockRejectedValueOnce(new Error("Reconnect YouTube with upload permission."));
      expect(await enqueueVideoPublish(f.tenantId, f.item.id, "youtube")).toMatchObject({ ok: false, error: expect.stringContaining("Reconnect") });
    } finally { await f.cleanup(); }
  });
  it("deduplicates concurrent submissions and preserves the reviewed snapshot across edits", async () => {
    const f = await fixture();
    try {
      await Promise.all([enqueueVideoPublish(f.tenantId, f.item.id, "youtube"), enqueueVideoPublish(f.tenantId, f.item.id, "youtube")]);
      await db.update(contentItemsTable).set({ videoPublishMetadata: { ...metadata, title: "Changed later" } }).where(eq(contentItemsTable.id, f.item.id));
      await enqueueVideoPublish(f.tenantId, f.item.id, "youtube");
      const rows = await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.contentItemId, f.item.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.title).toBe("Reviewed title");
      expect(rows[0].platform).toBe("youtube");
    } finally { await f.cleanup(); }
  });
  it("uses scheduled snapshots and finishes only active schedules after processing", async () => {
    const f = await fixture();
    try {
      const snapshot = { videoPath: f.item.videoPath!, metadata: { ...metadata, title: "Scheduled review" } };
      const [schedule] = await db.insert(scheduledPostsTable).values({ tenantId: f.tenantId, contentItemId: f.item.id, platform: "youtube", scheduledAt: new Date(), status: "processing", videoSnapshot: snapshot }).returning();
      expect(await enqueueVideoPublish(f.tenantId, f.item.id, "youtube", snapshot)).toMatchObject({ ok: true, pending: true });
      await runVideoPublishTick();
      const [upload] = await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.contentItemId, f.item.id));
      const [result] = await db.select().from(scheduledPostsTable).where(eq(scheduledPostsTable.id, schedule.id));
      expect(upload.metadata.title).toBe("Scheduled review");
      expect(upload.state).toBe("published");
      expect(result.status).toBe("published");
    } finally { await f.cleanup(); }
  });
});