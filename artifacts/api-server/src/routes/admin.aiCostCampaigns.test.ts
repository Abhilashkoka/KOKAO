import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { vi } from "vitest";

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

vi.mock("../lib/connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  checkSweepStaleness: vi.fn(async () => undefined),
  SWEEP_FAIL_RATIO_ALERT_THRESHOLD: 0.5,
}));

import { pool, db, usageEventsTable, campaignsTable } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";
import { createAdminTestApp } from "../test/testApp";
import { actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();

// A far-past month no real dev-DB rows live in, so assertions are exact.
const MONTH = "1997-03";
const IN_MONTH = new Date(Date.UTC(1997, 2, 10));

interface CampaignRow {
  tenantId: number;
  tenantName: string | null;
  tenantEmail: string | null;
  campaignId: string;
  campaignName: string | null;
  captionCount: number;
  imageCount: number;
  videoCount: number;
  totalCostPaise: number;
  unknownCount: number;
}

let admin: TestTenant;
let tenant: TestTenant;
let campaignId: number;
const createdEventIds: number[] = [];

async function seedEvent(
  tenantId: number,
  kind: string,
  costPaise: number | null,
  campaignId: string | null,
): Promise<void> {
  const [row] = await db
    .insert(usageEventsTable)
    .values({ tenantId, kind, costPaise, campaignId, createdAt: IN_MONTH })
    .returning({ id: usageEventsTable.id });
  createdEventIds.push(row.id);
}

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
  tenant = await createTenant();
  const [c] = await db
    .insert(campaignsTable)
    .values({ tenantId: tenant.tenantId, name: "Summer Launch", goal: "sales" })
    .returning({ id: campaignsTable.id });
  campaignId = c.id;
});

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await db
      .delete(usageEventsTable)
      .where(inArray(usageEventsTable.id, createdEventIds));
  }
  await db.delete(campaignsTable).where(eq(campaignsTable.id, campaignId));
  await deleteTenant(tenant.tenantId);
  await deleteTenant(admin.tenantId);
  await pool.end();
});

describe("GET /admin/ai-cost/campaigns", () => {
  it("sums caption/image/video costs per campaign and resolves names", async () => {
    // Campaign events: 2 captions (known), 1 image (known), 1 video (known),
    // 1 video (unknown cost). Plus a non-campaign caption that must NOT show.
    const cid = String(campaignId);
    await seedEvent(tenant.tenantId, "caption", 100, cid);
    await seedEvent(tenant.tenantId, "caption", 150, cid);
    await seedEvent(tenant.tenantId, "image", 700, cid);
    await seedEvent(tenant.tenantId, "video", 5000, cid);
    await seedEvent(tenant.tenantId, "video", null, cid);
    await seedEvent(tenant.tenantId, "caption", 999, null);
    // A campaign id with no matching campaign row (deleted campaign).
    await seedEvent(tenant.tenantId, "image", 300, "999999999");

    actAs(admin.clerkUserId, admin.email);
    const res = await request(app).get(`/api/admin/ai-cost/campaigns?month=${MONTH}`);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(MONTH);
    const rows = (res.body.campaigns as CampaignRow[]).filter(
      (r) => r.tenantId === tenant.tenantId,
    );
    expect(rows).toHaveLength(2);

    const live = rows.find((r) => r.campaignId === cid)!;
    expect(live.campaignName).toBe("Summer Launch");
    expect(live.captionCount).toBe(2);
    expect(live.imageCount).toBe(1);
    expect(live.videoCount).toBe(2);
    expect(live.totalCostPaise).toBe(100 + 150 + 700 + 5000);
    expect(live.unknownCount).toBe(1);
    expect(live.tenantEmail).toBe(tenant.email);

    const orphan = rows.find((r) => r.campaignId === "999999999")!;
    expect(orphan.campaignName).toBeNull();
    expect(orphan.totalCostPaise).toBe(300);

    // Sorted highest known cost first.
    const all = res.body.campaigns as CampaignRow[];
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].totalCostPaise).toBeGreaterThanOrEqual(all[i].totalCostPaise);
    }
  });

  it("rejects an invalid month and non-superadmins", async () => {
    actAs(admin.clerkUserId, admin.email);
    const bad = await request(app).get("/api/admin/ai-cost/campaigns?month=2026-13");
    expect(bad.status).toBe(400);

    actAs(tenant.clerkUserId, tenant.email);
    const forbidden = await request(app).get("/api/admin/ai-cost/campaigns");
    expect(forbidden.status).toBe(403);
  });
});
