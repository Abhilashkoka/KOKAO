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
import { createHmac } from "crypto";

// The webhook re-fetches the canonical order/subscription before crediting or
// entitling; stub those network calls while keeping the REAL HMAC signature
// verification (which reads the seeded cashfree credentials from the DB).
const getOrderMock = vi.hoisted(() => vi.fn());
const getSubMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/cashfree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cashfree")>();
  return {
    ...actual,
    getCashfreeOrder: getOrderMock,
    getCashfreeSubscription: getSubMock,
  };
});

import {
  pool,
  db,
  subscriptionsTable,
  creditPacksTable,
  creditLedgerTable,
  creditBalancesTable,
  cashfreeEventsTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";
import cashfreeWebhookRouter from "./cashfreeWebhook";
import type { AppCredential } from "@workspace/db";
import {
  createTenant,
  deleteTenant,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const SECRET = "cf_webhook_secret";

function buildApp(): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", cashfreeWebhookRouter);
  return app;
}

function post(app: Express, event: unknown, opts: { bad?: boolean; ts?: string } = {}) {
  const body = JSON.stringify(event);
  const ts = opts.ts ?? "1700000000";
  const sig = opts.bad
    ? "deadbeef"
    : createHmac("sha256", SECRET).update(ts + body).digest("base64");
  return request(app)
    .post("/api/billing/cashfree-webhook")
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", ts)
    .set("x-webhook-signature", sig)
    .send(body);
}

const app = buildApp();
let credsSnapshot: AppCredential | null = null;
let tenantId: number;
let packId: number;

beforeAll(async () => {
  credsSnapshot = await snapshotAppCredentialRow("cashfree");
  const t = await createTenant();
  tenantId = t.tenantId;
  const pack = (
    await db
      .insert(creditPacksTable)
      .values({
        name: "WH pack",
        pricePaise: 49900,
        captionCredits: 7,
        imageCredits: 3,
      })
      .returning()
  )[0];
  packId = pack.id;
});

afterAll(async () => {
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId));
  await db.delete(creditPacksTable).where(eq(creditPacksTable.id, packId));
  await db.delete(cashfreeEventsTable).where(like(cashfreeEventsTable.id, "cf_%"));
  await deleteTenant(tenantId);
  await restoreAppCredentialRow("cashfree", credsSnapshot);
  await pool.end();
});

beforeEach(async () => {
  getOrderMock.mockReset();
  getSubMock.mockReset();
  // Shared global cashfree credential row: re-seed each test.
  await setAppCredentialRow("cashfree", {
    appId: "APP",
    secretKey: SECRET,
    mode: "sandbox",
  });
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId));
});

describe("POST /billing/cashfree-webhook", () => {
  it("rejects an invalid signature", async () => {
    const res = await post(app, { type: "PAYMENT_SUCCESS_WEBHOOK" }, { bad: true });
    expect(res.status).toBe(400);
  });

  it("credits a pack on a PAID order and dedupes redeliveries", async () => {
    getOrderMock.mockResolvedValue({
      order_id: "cf_order_pack",
      order_amount: 499,
      order_status: "PAID",
      order_tags: {
        purpose: "credit_pack",
        tenantId: String(tenantId),
        creditPackId: String(packId),
      },
    });
    const event = {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      event_time: "2024-01-01T00:00:00Z",
      data: { order: { order_id: "cf_order_pack" } },
    };
    const first = await post(app, event);
    expect(first.status).toBe(200);
    const bal = (
      await db.select().from(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(bal.captionCredits).toBe(7);
    expect(bal.imageCredits).toBe(3);

    // Same event (same idempotency key) is acknowledged as duplicate.
    const dup = await post(app, event);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
  });

  it("does not credit when the order is not PAID", async () => {
    getOrderMock.mockResolvedValue({
      order_id: "cf_order_unpaid",
      order_amount: 499,
      order_status: "ACTIVE",
      order_tags: {
        purpose: "credit_pack",
        tenantId: String(tenantId),
        creditPackId: String(packId),
      },
    });
    const res = await post(app, {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      event_time: "2024-02-01T00:00:00Z",
      data: { order: { order_id: "cf_order_unpaid" } },
    });
    expect(res.status).toBe(200);
    const bal = await db
      .select()
      .from(creditBalancesTable)
      .where(eq(creditBalancesTable.tenantId, tenantId));
    expect(bal.length).toBe(0);
  });

  it("skips crediting when the PAID order amount doesn't match the pack price", async () => {
    // Charged 400 rupees (40000 paise) but the pack costs 49900 paise.
    getOrderMock.mockResolvedValue({
      order_id: "cf_order_pack_mismatch",
      order_amount: 400,
      order_status: "PAID",
      order_tags: {
        purpose: "credit_pack",
        tenantId: String(tenantId),
        creditPackId: String(packId),
      },
    });
    const res = await post(app, {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      event_time: "2024-02-15T00:00:00Z",
      data: { order: { order_id: "cf_order_pack_mismatch" } },
    });
    // Webhook acknowledges (no retry) but never credits.
    expect(res.status).toBe(200);
    const bal = await db
      .select()
      .from(creditBalancesTable)
      .where(eq(creditBalancesTable.tenantId, tenantId));
    expect(bal.length).toBe(0);
    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    expect(ledger.length).toBe(0);
  });

  it("activates the plan on an ACTIVE subscription event", async () => {
    const subId = `cf_sub_wh_${Date.now()}`;
    await db.insert(subscriptionsTable).values({
      tenantId,
      planId: "pro",
      gateway: "cashfree",
      cashfreeSubscriptionId: subId,
      status: "created",
    });
    getSubMock.mockResolvedValue({
      subscription_id: subId,
      subscription_status: "ACTIVE",
      current_cycle: { cycle_end_time: "2030-01-01T00:00:00Z" },
    });
    const res = await post(app, {
      type: "SUBSCRIPTION_STATUS_WEBHOOK",
      event_time: "2024-03-01T00:00:00Z",
      data: { subscription_details: { subscription_id: subId } },
    });
    expect(res.status).toBe(200);
    const row = (
      await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.cashfreeSubscriptionId, subId))
        .limit(1)
    )[0];
    expect(row.status).toBe("active");
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.cashfreeSubscriptionId, subId));
  });
});
