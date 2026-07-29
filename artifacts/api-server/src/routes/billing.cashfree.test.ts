import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import express, { type Express } from "express";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? { userId: authState.userId, sessionClaims: { userId: authState.userId } }
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
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

// Stub only the Cashfree network layer; DB writes, idempotency, and the
// gateway switch stay real.
const createOrderMock = vi.hoisted(() => vi.fn());
const getOrderMock = vi.hoisted(() => vi.fn());
const createSubMock = vi.hoisted(() => vi.fn());
const getSubMock = vi.hoisted(() => vi.fn());
const cancelSubMock = vi.hoisted(() => vi.fn());
const createPlanMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/cashfree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cashfree")>();
  return {
    ...actual,
    isCashfreeConfigured: vi.fn(async () => true),
    getCashfreeCredentials: vi.fn(async () => ({
      appId: "APP",
      secretKey: "SECRET",
      mode: "sandbox" as const,
    })),
    createCashfreeOrder: createOrderMock,
    getCashfreeOrder: getOrderMock,
    createCashfreeSubscription: createSubMock,
    getCashfreeSubscription: getSubMock,
    cancelCashfreeSubscription: cancelSubMock,
    createCashfreePlan: createPlanMock,
  };
});

import {
  pool,
  db,
  subscriptionsTable,
  creditPacksTable,
  creditLedgerTable,
  creditBalancesTable,
  planSettingsTable,
  tenantsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import billingRouter from "./billing";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  snapshotPaymentGatewaySettings,
  restorePaymentGatewaySettings,
  setPaymentGatewaySettings,
} from "../test/dbHelpers";
import { invalidateGatewayCache } from "../lib/paymentGateway";
import { invalidatePlanCache } from "../lib/plans";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, billingRouter);
  return app;
}

const app = buildApp();
let gatewaySnapshot: Awaited<ReturnType<typeof snapshotPaymentGatewaySettings>>;
let tenantId: number;
let clerkUserId: string;
let packId: number;
const PLAN_ID = "cf-test-plan";

beforeAll(async () => {
  gatewaySnapshot = await snapshotPaymentGatewaySettings();
  const t = await createTenant();
  tenantId = t.tenantId;
  clerkUserId = t.clerkUserId;
  const pack = (
    await db
      .insert(creditPacksTable)
      .values({
        name: "CF pack",
        pricePaise: 49900,
        captionCredits: 10,
        imageCredits: 5,
      })
      .returning()
  )[0];
  packId = pack.id;
  await db.insert(planSettingsTable).values({
    id: PLAN_ID,
    name: "CF Plan",
    priceLabel: "₹499/mo",
    priceInr: 49900,
    captions: 100,
    images: 50,
    videos: 5,
    brandKits: 1,
    scheduledPosts: 10,
    features: [],
  });
  invalidatePlanCache();
});

afterAll(async () => {
  resetAuthState();
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId));
  await db.delete(creditPacksTable).where(eq(creditPacksTable.id, packId));
  await db.delete(planSettingsTable).where(eq(planSettingsTable.id, PLAN_ID));
  await restorePaymentGatewaySettings(gatewaySnapshot);
  invalidateGatewayCache();
  invalidatePlanCache();
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  actAs(clerkUserId);
  createOrderMock.mockReset();
  getOrderMock.mockReset();
  createSubMock.mockReset();
  getSubMock.mockReset();
  cancelSubMock.mockReset();
  createPlanMock.mockReset();
  await setPaymentGatewaySettings("cashfree");
  invalidateGatewayCache();
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId));
  // Reset plan cashfree ids between tests.
  await db
    .update(planSettingsTable)
    .set({ cashfreePlanId: null, cashfreePlanIdYearly: null })
    .where(eq(planSettingsTable.id, PLAN_ID));
  invalidatePlanCache();
});

describe("Cashfree credit-pack purchase", () => {
  it("creates a Cashfree order and credits only after PAID", async () => {
    createOrderMock.mockResolvedValue({
      orderId: "kokao_w_abc",
      paymentSessionId: "sess_1",
    });
    const start = await request(app)
      .post("/api/billing/purchase-credits")
      .send({ creditPackId: packId });
    expect(start.status).toBe(200);
    expect(start.body.gateway).toBe("cashfree");
    expect(start.body.cashfreeOrderId).toBe("kokao_w_abc");

    // Verify before payment: not paid yet -> 409, no credit.
    getOrderMock.mockResolvedValueOnce({
      order_id: "kokao_w_abc",
      order_amount: 499,
      order_currency: "INR",
      order_status: "ACTIVE",
      order_tags: {
        purpose: "credit_pack",
        tenantId: String(tenantId),
        creditPackId: String(packId),
      },
    });
    const early = await request(app)
      .post("/api/billing/verify-purchase")
      .send({ cashfreeOrderId: "kokao_w_abc" });
    expect(early.status).toBe(409);

    // Now PAID -> credited.
    getOrderMock.mockResolvedValue({
      order_id: "kokao_w_abc",
      order_amount: 499,
      order_currency: "INR",
      order_status: "PAID",
      order_tags: {
        purpose: "credit_pack",
        tenantId: String(tenantId),
        creditPackId: String(packId),
      },
    });
    const verified = await request(app)
      .post("/api/billing/verify-purchase")
      .send({ cashfreeOrderId: "kokao_w_abc" });
    expect(verified.status).toBe(200);
    expect(verified.body.credits.captionCredits).toBe(10);

    // Replay must not double-credit (ledger unique on cashfree_order_id).
    const replay = await request(app)
      .post("/api/billing/verify-purchase")
      .send({ cashfreeOrderId: "kokao_w_abc" });
    expect(replay.status).toBe(200);
    expect(replay.body.credits.captionCredits).toBe(10);
  });

  it("rejects an order that belongs to a different tenant", async () => {
    getOrderMock.mockResolvedValue({
      order_id: "kokao_w_other",
      order_amount: 499,
      order_currency: "INR",
      order_status: "PAID",
      order_tags: {
        purpose: "credit_pack",
        tenantId: String(tenantId + 999999),
        creditPackId: String(packId),
      },
    });
    const res = await request(app)
      .post("/api/billing/verify-purchase")
      .send({ cashfreeOrderId: "kokao_w_other" });
    expect(res.status).toBe(400);
  });
});

describe("Cashfree subscription", () => {
  it("lazy-mints the plan id, subscribes, and activates on ACTIVE", async () => {
    createPlanMock.mockResolvedValue({ plan_id: "kokao_plan_1" });
    createSubMock.mockResolvedValue({
      subscriptionId: "kokao_sub_1",
      subscriptionSessionId: "subsess_1",
    });
    // Owner-only route; the tenant creator is the owner.
    const start = await request(app)
      .post("/api/billing/subscribe")
      .send({ planId: PLAN_ID, billingCycle: "monthly" });
    expect(start.status).toBe(200);
    expect(start.body.gateway).toBe("cashfree");
    expect(start.body.cashfreeSubscriptionId).toBe("kokao_sub_1");
    // The mint was persisted onto the plan row.
    const planRow = (
      await db.select().from(planSettingsTable).where(eq(planSettingsTable.id, PLAN_ID)).limit(1)
    )[0];
    expect(planRow.cashfreePlanId).toBe("kokao_plan_1");

    getSubMock.mockResolvedValue({
      subscription_id: "kokao_sub_1",
      subscription_status: "ACTIVE",
      current_cycle: { cycle_end_time: "2030-01-01T00:00:00Z" },
    });
    const verify = await request(app)
      .post("/api/billing/verify-subscription")
      .send({ cashfreeSubscriptionId: "kokao_sub_1" });
    expect(verify.status).toBe(200);
    expect(verify.body.plan).toBe(PLAN_ID);
    expect((await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)))[0].plan).toBe(
      PLAN_ID,
    );
  });

  it("does not activate when the subscription is not ACTIVE", async () => {
    createPlanMock.mockResolvedValue({ plan_id: "kokao_plan_2" });
    createSubMock.mockResolvedValue({
      subscriptionId: "kokao_sub_2",
      subscriptionSessionId: "subsess_2",
    });
    await request(app)
      .post("/api/billing/subscribe")
      .send({ planId: PLAN_ID, billingCycle: "monthly" });
    getSubMock.mockResolvedValue({
      subscription_id: "kokao_sub_2",
      subscription_status: "INITIALIZED",
    });
    const verify = await request(app)
      .post("/api/billing/verify-subscription")
      .send({ cashfreeSubscriptionId: "kokao_sub_2" });
    expect(verify.status).toBe(409);
  });

  it("cancels an active Cashfree subscription", async () => {
    createPlanMock.mockResolvedValue({ plan_id: "kokao_plan_3" });
    createSubMock.mockResolvedValue({
      subscriptionId: "kokao_sub_3",
      subscriptionSessionId: "subsess_3",
    });
    await request(app)
      .post("/api/billing/subscribe")
      .send({ planId: PLAN_ID, billingCycle: "monthly" });
    getSubMock.mockResolvedValue({
      subscription_id: "kokao_sub_3",
      subscription_status: "ACTIVE",
      current_cycle: { cycle_end_time: "2030-01-01T00:00:00Z" },
    });
    await request(app)
      .post("/api/billing/verify-subscription")
      .send({ cashfreeSubscriptionId: "kokao_sub_3" });

    cancelSubMock.mockResolvedValue({
      subscription_id: "kokao_sub_3",
      subscription_status: "CANCELLED",
    });
    const cancel = await request(app).post("/api/billing/cancel").send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);
    const sub = (
      await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.cashfreeSubscriptionId, "kokao_sub_3"))
        .limit(1)
    )[0];
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });
});
