/**
 * Full checkout round trip against the reusable Razorpay mock server
 * (scripts/src/razorpayMockServer.mjs), exactly as the mobile app drives it:
 *
 *   buy pack:  POST /billing/purchase-credits -> checkout pays (mock mark-paid)
 *              -> POST /billing/verify-purchase -> credits granted in DB
 *   upgrade:   POST /billing/subscribe -> checkout authorizes (mock mark-active)
 *              -> POST /billing/verify-subscription -> tenant plan updated
 *
 * Unlike the jsdom unit tests, nothing in lib/razorpay is mocked here: the
 * server's real HTTP client talks to the spawned mock over RAZORPAY_API_BASE_URL
 * and real HMAC signatures are computed with the seeded key secret.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import {
  pool,
  db,
  tenantsTable,
  subscriptionsTable,
  creditPacksTable,
  creditLedgerTable,
  creditBalancesTable,
  planSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

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

const MOCK_PORT = 19095;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
process.env.RAZORPAY_API_BASE_URL = MOCK_BASE;

const KEY_SECRET = "test_key_secret_roundtrip";

import { requireTenant } from "../middlewares/requireTenant";
import billingRouter from "./billing";
import { invalidatePlanCache } from "../lib/plans";
import { actAs, resetAuthState } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getTenant,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

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

function signOrder(orderId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function signSubscription(subscriptionId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
}

async function mockPost(pathname: string): Promise<Response> {
  return fetch(`${MOCK_BASE}${pathname}`, { method: "POST" });
}

const app = buildApp();
let mockServer: ChildProcess;
let credsSnapshot: Awaited<ReturnType<typeof snapshotAppCredentialRow>>;
let tenantId: number;
let clerkUserId: string;
let otherTenantId: number;
let otherClerkUserId: string;
let packId: number;
let activeSubscriptionId: string;
const PLAN_ID = `e2e_rt_plan_${Date.now()}`;

beforeAll(async () => {
  // Spawn the real reusable mock server on a dedicated port.
  const script = path.resolve(__dirname, "../../../../scripts/src/razorpayMockServer.mjs");
  mockServer = spawn("node", [script], {
    env: { ...process.env, PORT: String(MOCK_PORT) },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${MOCK_BASE}/payments`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("razorpay mock did not start");
    await new Promise((r) => setTimeout(r, 100));
  }

  credsSnapshot = await snapshotAppCredentialRow("razorpay");
  await setAppCredentialRow("razorpay", {
    keyId: "rzp_test_roundtrip",
    keySecret: KEY_SECRET,
    webhookSecret: "test_webhook_secret",
  });

  const t = await createTenant();
  tenantId = t.tenantId;
  clerkUserId = t.clerkUserId;
  const other = await createTenant();
  otherTenantId = other.tenantId;
  otherClerkUserId = other.clerkUserId;
  actAs(clerkUserId);

  const pack = (
    await db
      .insert(creditPacksTable)
      .values({
        name: "Roundtrip pack",
        pricePaise: 49900,
        captionCredits: 100,
        imageCredits: 40,
      })
      .returning()
  )[0];
  packId = pack.id;

  // Purchasable custom plan whose Razorpay Plan lives on the mock.
  const rzpPlan = (await (
    await fetch(`${MOCK_BASE}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        period: "monthly",
        interval: 1,
        item: { name: "Roundtrip", amount: 99900, currency: "INR" },
      }),
    })
  ).json()) as { id: string };
  await db.insert(planSettingsTable).values({
    id: PLAN_ID,
    name: "Roundtrip Plan",
    priceLabel: "₹999 / mo",
    captions: 500,
    images: 200,
    brandKits: 5,
    scheduledPosts: 100,
    features: ["roundtrip"],
    teamSeats: 0,
    priceInr: 99900,
    razorpayPlanId: rzpPlan.id,
    sortOrder: 99,
  });
  invalidatePlanCache();
});

afterAll(async () => {
  mockServer?.kill();
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId));
  await db.delete(creditPacksTable).where(eq(creditPacksTable.id, packId));
  await db.delete(planSettingsTable).where(eq(planSettingsTable.id, PLAN_ID));
  invalidatePlanCache();
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, otherTenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, otherTenantId));
  await deleteTenant(tenantId);
  await deleteTenant(otherTenantId);
  await restoreAppCredentialRow("razorpay", credsSnapshot);
  resetAuthState();
  await pool.end();
});

describe("credit pack purchase round trip (real mock server)", () => {
  let orderId: string;

  it("creates a Razorpay order on the mock", async () => {
    const res = await request(app)
      .post("/api/billing/purchase-credits")
      .send({ creditPackId: packId });
    expect(res.status).toBe(200);
    expect(res.body.razorpayOrderId).toMatch(/^order_MOCK/);
    expect(res.body.amountPaise).toBe(49900);
    orderId = res.body.razorpayOrderId;
  });

  it("rejects verification while the order is still unpaid", async () => {
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: "pay_RT001",
      razorpaySignature: signOrder(orderId, "pay_RT001"),
    });
    expect(res.status).toBe(409);
    const bal = (
      await db
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(bal?.captionCredits ?? 0).toBe(0);
  });

  it("rejects a bad checkout signature even after payment", async () => {
    await mockPost(`/orders/${orderId}/mark-paid`);
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: "pay_RT001",
      razorpaySignature: "deadbeef".repeat(8),
    });
    expect(res.status).toBe(400);
  });

  it("grants credits after a valid, paid verification", async () => {
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: "pay_RT001",
      razorpaySignature: signOrder(orderId, "pay_RT001"),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.credits.captionCredits).toBe(100);
    expect(res.body.credits.imageCredits).toBe(40);

    const bal = (
      await db
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(bal.captionCredits).toBe(100);
    expect(bal.imageCredits).toBe(40);

    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe("purchase");
    expect(ledger[0].razorpayOrderId).toBe(orderId);
    expect(ledger[0].captionDelta).toBe(100);
  });

  it("is idempotent: re-verifying the same order never double-credits", async () => {
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: "pay_RT001",
      razorpaySignature: signOrder(orderId, "pay_RT001"),
    });
    expect(res.status).toBe(200);
    const bal = (
      await db
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(bal.captionCredits).toBe(100);
    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    expect(ledger).toHaveLength(1);
  });
});

describe("subscription upgrade round trip (real mock server)", () => {
  let subscriptionId: string;

  it("creates a Razorpay subscription on the mock", async () => {
    const res = await request(app)
      .post("/api/billing/subscribe")
      .send({ planId: PLAN_ID });
    expect(res.status).toBe(200);
    expect(res.body.razorpaySubscriptionId).toMatch(/^sub_MOCK/);
    subscriptionId = res.body.razorpaySubscriptionId;

    const row = (
      await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.tenantId, tenantId))
    )[0];
    expect(row.razorpaySubscriptionId).toBe(subscriptionId);
    expect(row.status).toBe("created");
  });

  it("rejects activation while the subscription is still 'created'", async () => {
    const res = await request(app)
      .post("/api/billing/verify-subscription")
      .send({
        razorpaySubscriptionId: subscriptionId,
        razorpayPaymentId: "pay_RT002",
        razorpaySignature: signSubscription(subscriptionId, "pay_RT002"),
      });
    expect(res.status).toBe(409);
    expect((await getTenant(tenantId)).plan).toBe("free");
  });

  it("activates the plan after checkout succeeds", async () => {
    await mockPost(`/subscriptions/${subscriptionId}/mark-active`);
    const res = await request(app)
      .post("/api/billing/verify-subscription")
      .send({
        razorpaySubscriptionId: subscriptionId,
        razorpayPaymentId: "pay_RT002",
        razorpaySignature: signSubscription(subscriptionId, "pay_RT002"),
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, plan: PLAN_ID });

    const tenant = await getTenant(tenantId);
    expect(tenant.plan).toBe(PLAN_ID);

    const row = (
      await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.tenantId, tenantId))
    )[0];
    expect(row.status).toBe("active");
    expect(row.currentPeriodEnd).not.toBeNull();
    activeSubscriptionId = subscriptionId;
  });

  it("reports the active subscription in the billing overview", async () => {
    const res = await request(app).get("/api/billing");
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe(PLAN_ID);
    expect(res.body.subscription.status).toBe("active");
    expect(res.body.credits.captionCredits).toBe(100);
  });
});

describe("cross-tenant replay is rejected (real mock server)", () => {
  let crossOrderId: string;

  it("tenant A creates and pays a fresh order on the mock", async () => {
    actAs(clerkUserId);
    const res = await request(app)
      .post("/api/billing/purchase-credits")
      .send({ creditPackId: packId });
    expect(res.status).toBe(200);
    crossOrderId = res.body.razorpayOrderId;
    const paid = await mockPost(`/orders/${crossOrderId}/mark-paid`);
    expect(paid.ok).toBe(true);
  });

  it("tenant B cannot verify A's paid order even with a valid signature", async () => {
    actAs(otherClerkUserId);
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: crossOrderId,
      razorpayPaymentId: "pay_RT_X1",
      razorpaySignature: signOrder(crossOrderId, "pay_RT_X1"),
    });
    expect(res.status).toBe(400);

    // B must not gain any credits or ledger entries.
    const bal = (
      await db
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, otherTenantId))
    )[0];
    expect(bal?.captionCredits ?? 0).toBe(0);
    expect(bal?.imageCredits ?? 0).toBe(0);
    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, otherTenantId));
    expect(ledger).toHaveLength(0);
  });

  it("tenant B cannot verify A's active subscription with a valid signature", async () => {
    actAs(otherClerkUserId);
    const res = await request(app)
      .post("/api/billing/verify-subscription")
      .send({
        razorpaySubscriptionId: activeSubscriptionId,
        razorpayPaymentId: "pay_RT_X2",
        razorpaySignature: signSubscription(activeSubscriptionId, "pay_RT_X2"),
      });
    expect(res.status).toBe(404);

    // B's plan and subscription rows are untouched.
    expect((await getTenant(otherTenantId)).plan).toBe("free");
    const subs = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.tenantId, otherTenantId));
    expect(subs).toHaveLength(0);
  });

  it("tenant A can still verify its own order afterwards", async () => {
    actAs(clerkUserId);
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: crossOrderId,
      razorpayPaymentId: "pay_RT_X1",
      razorpaySignature: signOrder(crossOrderId, "pay_RT_X1"),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const bal = (
      await db
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(bal.captionCredits).toBe(200);
    expect(bal.imageCredits).toBe(80);
    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    expect(ledger).toHaveLength(2);
  });
});

describe("guessed / nonexistent ids are rejected cleanly (real mock server)", () => {
  async function tenantALedger() {
    return db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
  }

  it("verify-purchase with a random order id fails with a generic 400 and no credits", async () => {
    actAs(clerkUserId);
    const before = await tenantALedger();
    const fakeOrderId = "order_XXXX00000000";
    // Even with a technically valid signature over the fake id (attacker who
    // somehow knows the secret can't mint credits from a nonexistent order).
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: fakeOrderId,
      razorpayPaymentId: "pay_RT_GUESS1",
      razorpaySignature: signOrder(fakeOrderId, "pay_RT_GUESS1"),
    });
    expect(res.status).toBe(400);
    // Same generic message as a bad signature — no order-existence oracle.
    expect(res.body.error).toBe("Payment verification failed");
    const after = await tenantALedger();
    expect(after).toHaveLength(before.length);
  });

  it("verify-purchase with a malformed order id also fails 400 with no ledger writes", async () => {
    const before = await tenantALedger();
    const malformed = "not-an-order-id";
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: malformed,
      razorpayPaymentId: "pay_RT_GUESS2",
      razorpaySignature: signOrder(malformed, "pay_RT_GUESS2"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Payment verification failed");
    const after = await tenantALedger();
    expect(after).toHaveLength(before.length);
  });

  it("verify-subscription with a nonexistent sub id returns 404 and leaves the plan alone", async () => {
    const planBefore = (await getTenant(tenantId)).plan;
    const fakeSubId = "sub_XXXX00000000";
    const res = await request(app)
      .post("/api/billing/verify-subscription")
      .send({
        razorpaySubscriptionId: fakeSubId,
        razorpayPaymentId: "pay_RT_GUESS3",
        razorpaySignature: signSubscription(fakeSubId, "pay_RT_GUESS3"),
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Subscription not found");
    expect((await getTenant(tenantId)).plan).toBe(planBefore);
  });
});

describe("retried purchase after a failed checkout (real mock server)", () => {
  // Balances carried over from the two prior purchases (first round trip
  // + the cross-tenant replay suite's order for tenant A).
  const BASE_CAPTIONS = 200;
  const BASE_IMAGES = 80;
  let orderA: string;
  let orderB: string;

  async function balances() {
    const row = (
      await db
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    return {
      captions: row?.captionCredits ?? 0,
      images: row?.imageCredits ?? 0,
    };
  }

  async function purchaseLedger() {
    const rows = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    return rows.filter((r) => r.kind === "purchase");
  }

  it("creates order A which the user abandons unpaid", async () => {
    actAs(clerkUserId);
    const res = await request(app)
      .post("/api/billing/purchase-credits")
      .send({ creditPackId: packId });
    expect(res.status).toBe(200);
    orderA = res.body.razorpayOrderId;
    expect(orderA).toMatch(/^order_MOCK/);
  });

  it("creates a fresh order B on retry, distinct from order A", async () => {
    const res = await request(app)
      .post("/api/billing/purchase-credits")
      .send({ creditPackId: packId });
    expect(res.status).toBe(200);
    orderB = res.body.razorpayOrderId;
    expect(orderB).toMatch(/^order_MOCK/);
    expect(orderB).not.toBe(orderA);
  });

  it("verifying paid order B credits exactly once, untouched by abandoned order A", async () => {
    await mockPost(`/orders/${orderB}/mark-paid`);
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderB,
      razorpayPaymentId: "pay_RT_B1",
      razorpaySignature: signOrder(orderB, "pay_RT_B1"),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const bal = await balances();
    expect(bal.captions).toBe(BASE_CAPTIONS + 100);
    expect(bal.images).toBe(BASE_IMAGES + 40);

    const purchases = await purchaseLedger();
    expect(purchases.map((p) => p.razorpayOrderId).sort()).not.toContain(orderA);
    const bEntries = purchases.filter((p) => p.razorpayOrderId === orderB);
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0].captionDelta).toBe(100);
    expect(bEntries[0].imageDelta).toBe(40);
  });

  it("still rejects order A while it remains unpaid, without crediting", async () => {
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderA,
      razorpayPaymentId: "pay_RT_A1",
      razorpaySignature: signOrder(orderA, "pay_RT_A1"),
    });
    expect(res.status).toBe(409);
    const bal = await balances();
    expect(bal.captions).toBe(BASE_CAPTIONS + 100);
    expect(bal.images).toBe(BASE_IMAGES + 40);
  });

  it("credits order A once when it eventually gets paid and verified", async () => {
    await mockPost(`/orders/${orderA}/mark-paid`);
    const res = await request(app).post("/api/billing/verify-purchase").send({
      razorpayOrderId: orderA,
      razorpayPaymentId: "pay_RT_A1",
      razorpaySignature: signOrder(orderA, "pay_RT_A1"),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const bal = await balances();
    expect(bal.captions).toBe(BASE_CAPTIONS + 200);
    expect(bal.images).toBe(BASE_IMAGES + 80);

    const purchases = await purchaseLedger();
    const aEntries = purchases.filter((p) => p.razorpayOrderId === orderA);
    const bEntries = purchases.filter((p) => p.razorpayOrderId === orderB);
    expect(aEntries).toHaveLength(1);
    expect(bEntries).toHaveLength(1);
    expect(aEntries[0].captionDelta).toBe(100);
    expect(aEntries[0].imageDelta).toBe(40);
  });

  it("re-verifying either order after both are credited never double-credits", async () => {
    for (const [orderId, paymentId] of [
      [orderA, "pay_RT_A1"],
      [orderB, "pay_RT_B1"],
    ] as const) {
      const res = await request(app).post("/api/billing/verify-purchase").send({
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signOrder(orderId, paymentId),
      });
      expect(res.status).toBe(200);
    }

    const bal = await balances();
    expect(bal.captions).toBe(BASE_CAPTIONS + 200);
    expect(bal.images).toBe(BASE_IMAGES + 80);

    // Ledger reconciles with the balance: sum of all deltas equals the
    // stored balance, and each order has exactly one ledger entry.
    const rows = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    const captionSum = rows.reduce((s, r) => s + r.captionDelta, 0);
    const imageSum = rows.reduce((s, r) => s + r.imageDelta, 0);
    expect(captionSum).toBe(bal.captions);
    expect(imageSum).toBe(bal.images);
    const orderIds = rows
      .map((r) => r.razorpayOrderId)
      .filter((id): id is string => id != null);
    expect(new Set(orderIds).size).toBe(orderIds.length);
  });
});
