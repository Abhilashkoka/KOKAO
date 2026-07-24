import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

import {
  db,
  pool,
  campaignsTable,
  contentItemsTable,
  postMetricsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createTestApp();

let tenant: TestTenant;
let other: TestTenant;

beforeEach(async () => {
  resetAuthState();
  tenant = await createTenant();
  other = await createTenant();
});

afterEach(async () => {
  for (const t of [tenant, other]) {
    await db.delete(postMetricsTable).where(eq(postMetricsTable.tenantId, t.tenantId));
    await db.delete(contentItemsTable).where(eq(contentItemsTable.tenantId, t.tenantId));
    await db.delete(campaignsTable).where(eq(campaignsTable.tenantId, t.tenantId));
    await deleteTenant(t.tenantId);
  }
});

afterAll(async () => {
  await pool.end();
});

describe("campaign CRUD", () => {
  it("creates, lists, updates and deletes a campaign", async () => {
    actAs(tenant.clerkUserId);

    const created = await request(app)
      .post("/api/campaigns")
      .send({ name: "Summer Launch", goal: "engagement", goalTarget: 500 });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Summer Launch");
    expect(created.body.status).toBe("active");

    const list = await request(app).get("/api/campaigns");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/campaigns/${created.body.id}`)
      .send({ status: "completed", name: "Summer Launch v2" });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("completed");
    expect(updated.body.name).toBe("Summer Launch v2");

    const del = await request(app).delete(`/api/campaigns/${created.body.id}`);
    expect(del.status).toBe(204);
    const after = await request(app).get("/api/campaigns");
    expect(after.body).toHaveLength(0);
  });

  it("rejects an inverted date window", async () => {
    actAs(tenant.clerkUserId);
    const res = await request(app).post("/api/campaigns").send({
      name: "Backwards",
      startsAt: "2026-08-01T00:00:00Z",
      endsAt: "2026-07-01T00:00:00Z",
    });
    expect(res.status).toBe(400);
  });

  it("is tenant-scoped: another tenant cannot see or touch the campaign", async () => {
    actAs(tenant.clerkUserId);
    const created = await request(app)
      .post("/api/campaigns")
      .send({ name: "Private" });
    expect(created.status).toBe(201);

    actAs(other.clerkUserId);
    expect((await request(app).get("/api/campaigns")).body).toHaveLength(0);
    expect(
      (await request(app).get(`/api/campaigns/${created.body.id}`)).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/campaigns/${created.body.id}`)).status,
    ).toBe(404);
  });

  it("delete detaches content items instead of deleting them", async () => {
    actAs(tenant.clerkUserId);
    const campaign = (
      await request(app).post("/api/campaigns").send({ name: "Detach me" })
    ).body;
    const item = (
      await request(app)
        .post("/api/content")
        .send({ title: "Post", caption: "hi", campaignId: campaign.id })
    ).body;
    expect(item.campaignId).toBe(campaign.id);

    await request(app).delete(`/api/campaigns/${campaign.id}`).expect(204);
    const after = await request(app).get(`/api/content/${item.id}`);
    expect(after.status).toBe(200);
    expect(after.body.campaignId).toBeNull();
  });

  it("rejects attaching content to another tenant's campaign", async () => {
    actAs(other.clerkUserId);
    const foreign = (
      await request(app).post("/api/campaigns").send({ name: "Foreign" })
    ).body;

    actAs(tenant.clerkUserId);
    const res = await request(app)
      .post("/api/content")
      .send({ title: "Post", caption: "hi", campaignId: foreign.id });
    expect(res.status).toBe(400);
  });
});

describe("campaign report", () => {
  it("aggregates post metrics across attached content", async () => {
    actAs(tenant.clerkUserId);
    const campaign = (
      await request(app).post("/api/campaigns").send({ name: "Perf" })
    ).body;
    const item = (
      await request(app)
        .post("/api/content")
        .send({ title: "Post A", caption: "a", campaignId: campaign.id })
    ).body;

    await db.insert(postMetricsTable).values([
      {
        tenantId: tenant.tenantId,
        contentItemId: item.id,
        platform: "facebook",
        postId: "fb_1",
        publishedAt: new Date(),
        likes: 10,
        comments: 2,
        shares: 1,
        impressions: 100,
        pollState: "active",
      },
      {
        tenantId: tenant.tenantId,
        contentItemId: item.id,
        platform: "linkedin",
        postId: "urn:li:share:1",
        publishedAt: new Date(),
        likes: 5,
        comments: 3,
        shares: 0,
        impressions: 0,
        pollState: "done",
      },
    ]);

    const report = await request(app).get(`/api/campaigns/${campaign.id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.totals).toMatchObject({
      likes: 15,
      comments: 5,
      shares: 1,
      impressions: 100,
      engagements: 21,
      trackedPosts: 2,
    });
    expect(report.body.items).toHaveLength(1);
    expect(report.body.items[0].metrics).toHaveLength(2);
  });
});

describe("metrics summary", () => {
  it("returns only the tenant's own rows", async () => {
    actAs(tenant.clerkUserId);
    const item = (
      await request(app).post("/api/content").send({ title: "P", caption: "c" })
    ).body;
    await db.insert(postMetricsTable).values({
      tenantId: tenant.tenantId,
      contentItemId: item.id,
      platform: "facebook",
      postId: "fb_9",
      publishedAt: new Date(),
      likes: 7,
      comments: 0,
      shares: 0,
      impressions: 42,
      pollState: "active",
    });

    const mine = await request(app).get("/api/metrics/summary");
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].likes).toBe(7);

    actAs(other.clerkUserId);
    const theirs = await request(app).get("/api/metrics/summary");
    expect(theirs.body).toHaveLength(0);
  });
});
