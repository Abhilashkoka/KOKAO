import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { db, pool, videoPublishesTable, contentItemsTable, adminAuditLogsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
vi.mock("../middlewares/requireSuperadmin", () => ({
  requireSuperadmin: vi.fn((req, res, next) => req.headers["x-test-superadmin"] === "yes" ? next() : res.status(403).json({ error: "Forbidden" })),
}));
vi.mock("../lib/videoPublishAuth", () => ({ videoPublishAuth: vi.fn(async () => ({ token: "never-expose", accountId: "original" })) }));
vi.mock("../lib/videoPublishProviders", async original => ({
  ...await original<typeof import("../lib/videoPublishProviders")>(),
  inspectVideoUpload: vi.fn(async () => "published"),
}));
import router from "./videoPublishSupport";
import { inspectVideoUpload } from "../lib/videoPublishProviders";
import { videoPublishAuth } from "../lib/videoPublishAuth";
const metadata = { destination: "youtube" as const, format: "video" as const, title: "Frozen", description: "Reviewed", privacy: "private" as const, madeForKids: false };
beforeEach(() => vi.clearAllMocks());
afterAll(() => pool.end());
async function fixture() {
  const owner = await createTenant();
  const other = await createTenant();
  const [item] = await db.insert(contentItemsTable).values({ tenantId: owner.tenantId, title: "Later edits", caption: "", status: "failed", videoPath: "/unused" }).returning();
  const [upload] = await db.insert(videoPublishesTable).values({
    tenantId: owner.tenantId, contentItemId: item.id, platform: "youtube", videoPath: "/unused",
    metadata, state: "attention", externalId: "exact", accountId: "original", encryptedSession: "secret-session",
  }).returning();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = req.headers["x-other"] ? other.tenantId : owner.tenantId;
    req.tenantEmail = null;
    req.clerkUserId = owner.clerkUserId;
    req.memberRole = req.headers["x-member"] ? "member" : "owner";
    next();
  });
  app.use(router);
  return { app, owner, other, item, upload,
    path: `/video-publish-support/${owner.tenantId}/${upload.id}`,
    body: { expectedUpdatedAt: upload.updatedAt.toISOString(), ownerCheckedDestination: true, outcome: "published" },
    cleanup: async () => {
      await db.delete(videoPublishesTable).where(eq(videoPublishesTable.id, upload.id));
      await deleteTenant(owner.tenantId); await deleteTenant(other.tenantId);
    },
  };
}
describe("video publish support", () => {
  it("isolates tenants and hides sensitive checkpoint fields", async () => {
    const f = await fixture();
    try {
      const response = await request(f.app).get("/video-publish-support");
      expect(response.status).toBe(200);
      expect(response.body[0]).toMatchObject({ id: f.upload.id, hasSession: true, metadata });
      expect(JSON.stringify(response.body)).not.toMatch(/secret-session|encryptedSession|videoPath|never-expose/);
      expect((await request(f.app).get("/video-publish-support").set("x-other", "yes")).body).toEqual([]);
      expect((await request(f.app).get("/video-publish-support").set("x-member", "yes")).status).toBe(403);
      expect((await request(f.app).get(`/video-publish-support?tenantId=${f.owner.tenantId}`).set("x-other", "yes")).status).toBe(403);
      expect((await request(f.app).post(`${f.path}/resolve`).set("x-other", "yes").send(f.body)).status).toBe(403);
      expect((await request(f.app).get(`/video-publish-support?tenantId=${f.owner.tenantId}`).set("x-other", "yes").set("x-test-superadmin", "yes")).body[0].id).toBe(f.upload.id);
    } finally { await f.cleanup(); }
  });
  it("reconciles read-only without changing frozen metadata or state", async () => {
    const f = await fixture();
    try {
      const response = await request(f.app).post(`${f.path}/reconcile`);
      expect(response.body).toEqual({ outcome: "published" });
      const [saved] = await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.id, f.upload.id));
      expect(saved).toEqual(f.upload);
      expect(inspectVideoUpload).toHaveBeenCalledTimes(1);
      vi.mocked(videoPublishAuth).mockResolvedValueOnce({ token: "secret", accountId: "changed" });
      expect((await request(f.app).post(`${f.path}/reconcile`)).status).toBe(409);
      vi.mocked(inspectVideoUpload).mockRejectedValueOnce(new Error("token=private-secret"));
      const failure = await request(f.app).post(`${f.path}/reconcile`);
      expect(failure.status).toBe(503);
      expect(JSON.stringify(failure.body)).not.toContain("private-secret");
    } finally { await f.cleanup(); }
  });
  it("requires explicit confirmation, rejects stale/extra data, and atomically audits manual publication", async () => {
    const f = await fixture();
    try {
      expect((await request(f.app).post(`${f.path}/resolve`).send({ ...f.body, ownerCheckedDestination: false })).status).toBe(400);
      expect((await request(f.app).post(`${f.path}/resolve`).send({ ...f.body, externalId: "replacement" })).status).toBe(400);
      expect((await request(f.app).post(`${f.path}/resolve`).send({ ...f.body, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" })).status).toBe(409);
      expect((await request(f.app).post(`${f.path}/resolve`).send(f.body)).status).toBe(200);
      const [saved] = await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.id, f.upload.id));
      expect(saved.state).toBe("published");
      expect(saved.metadata).toEqual(metadata);
      expect(saved.externalId).toBe("exact");
      const [item] = await db.select().from(contentItemsTable).where(eq(contentItemsTable.id, f.item.id));
      expect(item.status).toBe("published");
      expect(item.title).toBe("Later edits");
      const logs = await db.select().from(adminAuditLogsTable).where(and(eq(adminAuditLogsTable.targetTenantId, f.owner.tenantId), eq(adminAuditLogsTable.action, "video_publish_resolution")));
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0].newValue!)).toMatchObject({ uploadId: f.upload.id, state: "published", ownerCheckedDestination: true });
      expect((await request(f.app).post(`${f.path}/resolve`).send(f.body)).status).toBe(409);
      expect(inspectVideoUpload).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it("records not published without requeueing or erasing the exact ID", async () => {
    const f = await fixture();
    try {
      const result = await request(f.app).post(`${f.path}/resolve`).send({ ...f.body, outcome: "failed" });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ state: "failed", externalId: "exact", metadata });
      expect(inspectVideoUpload).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
});