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

// The rate fetcher goes through the bounded platformFetch helper — mock it so
// no test ever hits the real exchange-rate API.
vi.mock("../lib/platformFetch", () => ({
  platformFetch: vi.fn(),
  PLATFORM_FETCH_TIMEOUT_MS: 6000,
  PlatformTimeoutError: class extends Error {},
}));

import { pool, db, aiCostSettingsTable } from "@workspace/db";
import { platformFetch } from "../lib/platformFetch";
import {
  getAiCostConfig,
  refreshUsdInrRate,
  setAiCostMarkup,
  DEFAULT_RATE_MARKUP_PAISE,
} from "../lib/aiCost";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();
const mockedFetch = vi.mocked(platformFetch);

let admin: TestTenant;
let original: {
  usdToInrPaise: number;
  rateMarkupPaise: number;
  marketRatePaise: number | null;
  rateAutoUpdatedAt: Date | null;
} | null = null;

/** Reset the singleton settings row to a known baseline. */
async function seedSettings(values: {
  usdToInrPaise: number;
  rateMarkupPaise?: number | null;
  marketRatePaise?: number | null;
  rateAutoUpdatedAt?: Date | null;
}) {
  const set = {
    usdToInrPaise: values.usdToInrPaise,
    rateMarkupPaise: values.rateMarkupPaise ?? DEFAULT_RATE_MARKUP_PAISE,
    marketRatePaise: values.marketRatePaise ?? null,
    rateAutoUpdatedAt: values.rateAutoUpdatedAt ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: aiCostSettingsTable.id, set });
}

function fetchOk(inr: number) {
  mockedFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ rates: { INR: inr } }),
  } as unknown as Response);
}

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
  const [row] = await db.select().from(aiCostSettingsTable).limit(1);
  original = row
    ? {
        usdToInrPaise: row.usdToInrPaise,
        rateMarkupPaise: row.rateMarkupPaise,
        marketRatePaise: row.marketRatePaise,
        rateAutoUpdatedAt: row.rateAutoUpdatedAt,
      }
    : null;
});

afterAll(async () => {
  if (original) await seedSettings(original);
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
  mockedFetch.mockReset();
});

describe("refreshUsdInrRate", () => {
  it("saves market rate + default ₹2.00 markup when no markup was ever set", async () => {
    await seedSettings({ usdToInrPaise: 0 });
    fetchOk(87.5);
    const config = await refreshUsdInrRate();
    expect(config.marketRatePaise).toBe(8750);
    expect(config.rateMarkupPaise).toBe(200);
    expect(config.usdToInrPaise).toBe(8950);
    expect(config.rateAutoUpdatedAt).toBeInstanceOf(Date);
  });

  it("applies a custom markup", async () => {
    await seedSettings({ usdToInrPaise: 8950, rateMarkupPaise: 350 });
    fetchOk(88.0);
    const config = await refreshUsdInrRate();
    expect(config.usdToInrPaise).toBe(8800 + 350);
    expect(config.marketRatePaise).toBe(8800);
  });

  it("keeps the previous rate untouched when the fetch fails", async () => {
    await seedSettings({
      usdToInrPaise: 9100,
      marketRatePaise: 8900,
      rateAutoUpdatedAt: new Date("2026-07-01T00:00:00Z"),
    });
    mockedFetch.mockRejectedValueOnce(new Error("network down"));
    await expect(refreshUsdInrRate()).rejects.toThrow("network down");
    const config = await getAiCostConfig();
    expect(config.usdToInrPaise).toBe(9100);
    expect(config.marketRatePaise).toBe(8900);
    expect(config.rateAutoUpdatedAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("rejects a response without a usable INR rate and keeps the rate", async () => {
    await seedSettings({ usdToInrPaise: 9100 });
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ rates: {} }),
    } as unknown as Response);
    await expect(refreshUsdInrRate()).rejects.toThrow(/no usable INR rate/);
    expect((await getAiCostConfig()).usdToInrPaise).toBe(9100);
  });

  it("rejects a non-200 response and keeps the rate", async () => {
    await seedSettings({ usdToInrPaise: 9100 });
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);
    await expect(refreshUsdInrRate()).rejects.toThrow(/503/);
    expect((await getAiCostConfig()).usdToInrPaise).toBe(9100);
  });
});

describe("PUT /admin/ai-cost/markup", () => {
  it("updates the markup and returns it in the config view", async () => {
    await seedSettings({ usdToInrPaise: 9100 });
    const res = await request(app)
      .put("/api/admin/ai-cost/markup")
      .send({ rateMarkupPaise: 150 });
    expect(res.status).toBe(200);
    expect(res.body.rateMarkupPaise).toBe(150);
    // The saved rate is unchanged until the next refresh.
    expect(res.body.usdToInrPaise).toBe(9100);
    expect((await setAiCostMarkup(150)).rateMarkupPaise).toBe(150);
  });

  it("rejects an invalid markup", async () => {
    const res = await request(app)
      .put("/api/admin/ai-cost/markup")
      .send({ rateMarkupPaise: -5 });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/ai-cost/rate/refresh", () => {
  it("refreshes immediately using the current markup", async () => {
    await seedSettings({ usdToInrPaise: 0, rateMarkupPaise: 200 });
    fetchOk(86.42);
    const res = await request(app).post("/api/admin/ai-cost/rate/refresh");
    expect(res.status).toBe(200);
    expect(res.body.marketRatePaise).toBe(8642);
    expect(res.body.usdToInrPaise).toBe(8842);
    expect(typeof res.body.rateAutoUpdatedAt).toBe("string");
  });

  it("responds 502 and keeps the saved rate when the fetch fails", async () => {
    await seedSettings({ usdToInrPaise: 8842, marketRatePaise: 8642 });
    mockedFetch.mockRejectedValueOnce(new Error("boom"));
    const res = await request(app).post("/api/admin/ai-cost/rate/refresh");
    expect(res.status).toBe(502);
    const config = await getAiCostConfig();
    expect(config.usdToInrPaise).toBe(8842);
  });
});
