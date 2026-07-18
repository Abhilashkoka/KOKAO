import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { createHmac } from "crypto";
import {
  pool,
  db,
  subscriptionsTable,
  creditPacksTable,
  razorpayEventsTable,
  creditLedgerTable,
  creditBalancesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { vi } from "vitest";

// The webhook cross-checks the canonical order with Razorpay before
// crediting; stub that network call while keeping real signature logic.
const fetchOrderMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/razorpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/razorpay")>();
  return { ...actual, fetchRazorpayOrder: fetchOrderMock };
});

import razorpayWebhookRouter from "./razorpayWebhook";
import {
  createTenant,
  deleteTenant,
  getTenant,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const WEBHOOK_SECRET = "test_webhook_secret";

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
  app.use("/api", razorpayWebhookRouter);
  return app;
}

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function post(
  app: Express,
  event: unknown,
  opts: { eventId?: string; badSignature?: boolean } = {},
) {
  const body = JSON.stringify(event);
  let req = request(app)
    .post("/api/billing/razorpay-webhook")
    .set("Content-Type", "application/json")
    .set(
      "x-razorpay-signature",
      opts.badSignature ? "deadbeef".repeat(8) : sign(body),
    );
  if (opts.eventId) req = req.set("x-razorpay-event-id", opts.eventId);
  return req.send(body);
}

const app = buildApp();
let credsSnapshot: Awaited<ReturnType<typeof snapshotAppCredentialRow>>;
let tenantId: number;
let packId: number;
const eventIds: string[] = [];

beforeAll(async () => {
  credsSnapshot = await snapshotAppCredentialRow("razorpay");
  await setAppCredentialRow("razorpay", {
    keyId: "rzp_test_key",
    keySecret: "test_key_secret",
    webhookSecret: WEBHOOK_SECRET,
  });
  const t = await createTenant();
  tenantId = t.tenantId;
  const pack = (
    await db
      .insert(creditPacksTable)
      .values({
        name: "Test pack",
        pricePaise: 49900,
        captionCredits: 10,
        imageCredits: 5,
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
  if (eventIds.length > 0) {
    await db.delete(razorpayEventsTable).where(inArray(razorpayEventsTable.id, eventIds));
  }
  await deleteTenant(tenantId);
  await restoreAppCredentialRow("razorpay", credsSnapshot);
  await pool.end();
});

function evId(suffix: string): string {
  const id = `evt_test_${Date.now()}_${suffix}`;
  eventIds.push(id);
  return id;
}

describe("POST /billing/razorpay-webhook", () => {
  it("rejects an invalid signature", async () => {
    const res = await post(app, { event: "payment.captured" }, { badSignature: true });
    expect(res.status).toBe(400);
  });

  it("activates the plan on subscription.activated and lapses to payg on cancelled", async () => {
    const subId = `sub_test_${Date.now()}`;
    await db.insert(subscriptionsTable).values({
      tenantId,
      planId: "pro",
      razorpaySubscriptionId: subId,
      status: "created",
    });

    const activate = await post(
      app,
      {
        event: "subscription.activated",
        payload: { subscription: { entity: { id: subId, status: "active", current_end: 1893456000 } } },
      },
      { eventId: evId("act") },
    );
    expect(activate.status).toBe(200);
    expect((await getTenant(tenantId))?.plan).toBe("pro");
    const subRow = (
      await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.razorpaySubscriptionId, subId))
    )[0];
    expect(subRow.status).toBe("active");
    expect(subRow.currentPeriodEnd).not.toBeNull();

    const cancel = await post(
      app,
      {
        event: "subscription.cancelled",
        payload: { subscription: { entity: { id: subId, status: "cancelled" } } },
      },
      { eventId: evId("can") },
    );
    expect(cancel.status).toBe(200);
    expect((await getTenant(tenantId))?.plan).toBe("payg");
  });

  it("credits a pack on payment.captured and dedupes by event id and order id", async () => {
    const orderId = `order_test_${Date.now()}`;
    fetchOrderMock.mockResolvedValue({
      id: orderId,
      amount: 49900,
      currency: "INR",
      status: "paid",
      notes: {
        purpose: "credit_pack",
        tenantId: String(tenantId),
        creditPackId: String(packId),
      },
    });
    const eventId = evId("pay");
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_test_1",
            order_id: orderId,
            notes: {
              purpose: "credit_pack",
              tenantId: String(tenantId),
              creditPackId: String(packId),
            },
          },
        },
      },
    };

    const first = await post(app, event, { eventId });
    expect(first.status).toBe(200);
    const balance = (
      await db.select().from(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(balance.captionCredits).toBe(10);
    expect(balance.imageCredits).toBe(5);

    // Redelivery with the same event id is acknowledged without reprocessing.
    const redelivered = await post(app, event, { eventId });
    expect(redelivered.status).toBe(200);
    expect(redelivered.body.duplicate).toBe(true);

    // Same order under a NEW event id still cannot double-credit (ledger unique).
    const replay = await post(app, event, { eventId: evId("pay2") });
    expect(replay.status).toBe(200);
    const after = (
      await db.select().from(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(after.captionCredits).toBe(10);
    expect(after.imageCredits).toBe(5);
  });

  it("does not credit when the canonical order is not paid or the amount mismatches", async () => {
    const baseNotes = {
      purpose: "credit_pack",
      tenantId: String(tenantId),
      creditPackId: String(packId),
    };
    const makeEvent = (orderId: string) => ({
      event: "payment.captured",
      payload: {
        payment: { entity: { id: `pay_${orderId}`, order_id: orderId, notes: baseNotes } },
      },
    });

    // Order not in a paid state.
    const unpaidOrder = `order_unpaid_${Date.now()}`;
    fetchOrderMock.mockResolvedValueOnce({
      id: unpaidOrder,
      amount: 49900,
      currency: "INR",
      status: "attempted",
      notes: baseNotes,
    });
    expect((await post(app, makeEvent(unpaidOrder), { eventId: evId("unpaid") })).status).toBe(200);

    // Paid, but amount does not match the pack price.
    const cheapOrder = `order_cheap_${Date.now()}`;
    fetchOrderMock.mockResolvedValueOnce({
      id: cheapOrder,
      amount: 100,
      currency: "INR",
      status: "paid",
      notes: baseNotes,
    });
    expect((await post(app, makeEvent(cheapOrder), { eventId: evId("cheap") })).status).toBe(200);

    const balance = (
      await db.select().from(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenantId))
    )[0];
    expect(balance.captionCredits).toBe(10);
    expect(balance.imageCredits).toBe(5);
    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    expect(ledger.length).toBe(1);
  });
});
