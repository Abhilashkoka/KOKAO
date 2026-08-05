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

import { pool, db, aiModelPricesTable, adminAuditLogsTable } from "@workspace/db";
import { eq, and, like, desc } from "drizzle-orm";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();

const RUN = `dedupe-${Date.now()}`;
let admin: TestTenant;

afterAll(async () => {
  await db
    .delete(aiModelPricesTable)
    .where(like(aiModelPricesTable.model, `%${RUN}%`));
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
});

beforeEach(() => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
});

describe("POST /admin/ai-cost/prices/dedupe", () => {
  it("merges case/whitespace duplicates, keeps newest prices, and audits with the admin as actor", async () => {
    // Seed a duplicate pair directly (bypassing the normalizing upsert), the
    // way pre-normalization imports created them.
    const [older] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "text",
        provider: "builtin",
        model: `${RUN}-Model`,
        inputUsdPerMtok: 1,
        outputUsdPerMtok: 2,
        updatedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    const [newer] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "text",
        provider: "Builtin ",
        model: ` ${RUN}-model`,
        inputUsdPerMtok: 5,
        outputUsdPerMtok: 10,
        updatedAt: new Date(),
      })
      .returning();

    const res = await request(app).post("/api/admin/ai-cost/prices/dedupe");
    expect(res.status).toBe(200);
    expect(res.body.merged).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.config?.prices)).toBe(true);

    // Oldest row survives with the newest duplicate's prices; newer is gone.
    const remaining = await db
      .select()
      .from(aiModelPricesTable)
      .where(like(aiModelPricesTable.model, `%${RUN}-%`));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(older.id);
    expect(remaining[0].inputUsdPerMtok).toBe(5);
    expect(remaining[0].outputUsdPerMtok).toBe(10);

    // Audited under ai_cost_change with the requesting admin as actor.
    const [audit] = await db
      .select()
      .from(adminAuditLogsTable)
      .where(
        and(
          eq(adminAuditLogsTable.action, "ai_cost_change"),
          eq(adminAuditLogsTable.actorTenantId, admin.tenantId),
          like(adminAuditLogsTable.newValue, `%${newer.id}%`),
        ),
      )
      .orderBy(desc(adminAuditLogsTable.id))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit.oldValue).toContain(`#${newer.id}`);
    expect(audit.newValue).toContain(`#${older.id}`);
  });

  it("reports zero merges when the catalog is already clean", async () => {
    const res = await request(app).post("/api/admin/ai-cost/prices/dedupe");
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(0);
  });
});
