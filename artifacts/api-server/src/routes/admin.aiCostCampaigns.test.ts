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
let otherTenant: TestTenant;
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
  otherTenant = await createTenant();
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
  await deleteTenant(otherTenant.tenantId);
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

  it("never borrows another tenant's campaign name for a matching id", async () => {
    // Tenant B's usage rows carry a campaign id TEXT that happens to equal
    // tenant A's live campaign id. The name lookup is keyed by
    // tenantId:campaignId, so tenant B's row must show no name at all —
    // resolving "Summer Launch" here would leak tenant A's campaign name.
    const cid = String(campaignId);
    await seedEvent(otherTenant.tenantId, "caption", 250, cid);

    actAs(admin.clerkUserId, admin.email);
    const res = await request(app).get(`/api/admin/ai-cost/campaigns?month=${MONTH}`);
    expect(res.status).toBe(200);
    const all = res.body.campaigns as CampaignRow[];

    const borrowed = all.find(
      (r) => r.tenantId === otherTenant.tenantId && r.campaignId === cid,
    )!;
    expect(borrowed).toBeTruthy();
    expect(borrowed.campaignName).toBeNull();
    expect(borrowed.totalCostPaise).toBe(250);

    // The real owner's row still resolves its own name.
    const owner = all.find(
      (r) => r.tenantId === tenant.tenantId && r.campaignId === cid,
    )!;
    expect(owner.campaignName).toBe("Summer Launch");
  });

  it("filters by month boundary — cross-month campaign events don't bleed across months", async () => {
    // Seed events for the same campaign across two adjacent months:
    //   Dec 1997: one caption (200 paise) + one image (800 paise)
    //   Jan 1998: one video (3000 paise)
    const cid = String(campaignId);
    const decEvent1Id = await (async () => {
      const [row] = await db
        .insert(usageEventsTable)
        .values({
          tenantId: tenant.tenantId,
          kind: "caption",
          costPaise: 200,
          campaignId: cid,
          createdAt: new Date(Date.UTC(1997, 11, 15)), // 15 Dec 1997
        })
        .returning({ id: usageEventsTable.id });
      createdEventIds.push(row.id);
      return row.id;
    })();
    const decEvent2Id = await (async () => {
      const [row] = await db
        .insert(usageEventsTable)
        .values({
          tenantId: tenant.tenantId,
          kind: "image",
          costPaise: 800,
          campaignId: cid,
          createdAt: new Date(Date.UTC(1997, 11, 31, 23, 59, 59)), // last second of Dec 1997
        })
        .returning({ id: usageEventsTable.id });
      createdEventIds.push(row.id);
      return row.id;
    })();
    const janEventId = await (async () => {
      const [row] = await db
        .insert(usageEventsTable)
        .values({
          tenantId: tenant.tenantId,
          kind: "video",
          costPaise: 3000,
          campaignId: cid,
          createdAt: new Date(Date.UTC(1998, 0, 1)), // 1 Jan 1998 — exact boundary
        })
        .returning({ id: usageEventsTable.id });
      createdEventIds.push(row.id);
      return row.id;
    })();
    void decEvent1Id; void decEvent2Id; void janEventId; // suppress unused warnings

    actAs(admin.clerkUserId, admin.email);

    // Query December 1997 — must include only the two Dec events for this campaign.
    const decRes = await request(app).get("/api/admin/ai-cost/campaigns?month=1997-12");
    expect(decRes.status).toBe(200);
    expect(decRes.body.month).toBe("1997-12");
    const decRow = (decRes.body.campaigns as CampaignRow[]).find(
      (r) => r.tenantId === tenant.tenantId && r.campaignId === cid,
    );
    expect(decRow).toBeTruthy();
    expect(decRow!.captionCount).toBe(1);
    expect(decRow!.imageCount).toBe(1);
    expect(decRow!.videoCount).toBe(0); // Jan event must NOT appear
    expect(decRow!.totalCostPaise).toBe(200 + 800);

    // Query January 1998 — must include only the one Jan event.
    const janRes = await request(app).get("/api/admin/ai-cost/campaigns?month=1998-01");
    expect(janRes.status).toBe(200);
    expect(janRes.body.month).toBe("1998-01");
    const janRow = (janRes.body.campaigns as CampaignRow[]).find(
      (r) => r.tenantId === tenant.tenantId && r.campaignId === cid,
    );
    expect(janRow).toBeTruthy();
    expect(janRow!.videoCount).toBe(1);
    expect(janRow!.captionCount).toBe(0); // Dec events must NOT appear
    expect(janRow!.imageCount).toBe(0);
    expect(janRow!.totalCostPaise).toBe(3000);
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
