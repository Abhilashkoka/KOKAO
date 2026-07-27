import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

vi.mock("../lib/connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  checkSweepStaleness: vi.fn(async () => undefined),
  SWEEP_FAIL_RATIO_ALERT_THRESHOLD: 0.5,
}));

import { pool, db, aiModelPricesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();

const RUN = `vidprice-${Date.now()}`;
let admin: TestTenant;
const createdPriceIds: number[] = [];

interface PriceRow {
  id: number;
  kind: string;
  provider: string;
  model: string;
  usdPerSecond: number | null;
  usdPerVideo: number | null;
}

async function putPrice(body: Record<string, unknown>) {
  const res = await request(app).put("/api/admin/ai-cost/prices").send(body);
  if (res.status === 200) {
    const row = (res.body.prices as PriceRow[]).find(
      (p) => p.model === body.model && p.kind === body.kind,
    );
    if (row) createdPriceIds.push(row.id);
    return { status: res.status, row };
  }
  return { status: res.status, row: undefined, error: res.body.error as string };
}

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
});

afterAll(async () => {
  if (createdPriceIds.length > 0) {
    await db
      .delete(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, createdPriceIds));
  }
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
});

describe("PUT /admin/ai-cost/prices — video kind", () => {
  it("rejects a video row with neither per-second nor per-video price", async () => {
    const { status, error } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/none`,
    });
    expect(status).toBe(400);
    expect(error).toMatch(/per second|per video/i);
  });

  it("accepts a per-second-only video row", async () => {
    const { status, row } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/per-second`,
      usdPerSecond: 0.4,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({ usdPerSecond: 0.4, usdPerVideo: null });
  });

  it("accepts a per-video-only video row", async () => {
    const { status, row } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/per-video`,
      usdPerVideo: 1.25,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({ usdPerSecond: null, usdPerVideo: 1.25 });
  });

  it("accepts both prices and ignores token/image fields on video rows", async () => {
    const { status, row } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/both`,
      usdPerSecond: 0.2,
      usdPerVideo: 3,
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 10,
      usdPerImage: 0.04,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({
      usdPerSecond: 0.2,
      usdPerVideo: 3,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
    });
  });

  it("never stores video prices on text rows", async () => {
    const { status, row } = await putPrice({
      kind: "text",
      provider: "builtin",
      model: `${RUN}-text`,
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      usdPerSecond: 9,
      usdPerVideo: 9,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({ usdPerSecond: null, usdPerVideo: null });
  });
});
