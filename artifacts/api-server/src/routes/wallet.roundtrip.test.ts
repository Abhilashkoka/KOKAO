/**
 * Wallet top-up round trip against the reusable Razorpay mock server, the way
 * the browser drives it:
 *
 *   POST /wallet/recharge  -> order raised for base + GST
 *   checkout pays          -> mock mark-paid
 *   POST /wallet/verify-recharge -> ONLY the base lands in the wallet
 *
 * Nothing in lib/razorpay is mocked: the server's real HTTP client talks to the
 * spawned mock and real HMAC signatures are computed with the seeded secret.
 * The point of the test is the money split — a tenant who asks for ₹1,000 pays
 * ₹1,180 and receives ₹1,000.
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
  walletBalancesTable,
  walletLedgerTable,
  walletSettingsTable,
  aiSpendSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

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

const MOCK_PORT = 19097;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
process.env.RAZORPAY_API_BASE_URL = MOCK_BASE;

const KEY_SECRET = "test_key_secret_wallet";

import { requireTenant } from "../middlewares/requireTenant";
import walletRouter from "./wallet";
import { setWalletConfig } from "../lib/wallet";
import { setAiSpendConfig } from "../lib/aiSpend";
import { actAs, resetAuthState } from "../test/authState";
import {
  createTenant,
  deleteTenant,
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
  app.use("/api", requireTenant, walletRouter);
  return app;
}

function signOrder(orderId: string, paymentId: string): string {
  return createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

const app = buildApp();
let mockServer: ChildProcess;
let credsSnapshot: Awaited<ReturnType<typeof snapshotAppCredentialRow>>;
let tenantId: number;
let clerkUserId: string;

beforeAll(async () => {
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
    keyId: "rzp_test_wallet",
    keySecret: KEY_SECRET,
    webhookSecret: "test_webhook_secret",
  });

  await setAiSpendConfig({ captionCostPaise: 200, imageCostPaise: 500, feePercent: 20 });
  await setWalletConfig({
    gstPercent: 18,
    minTopupPaise: 10_000,
    lowBalanceThresholdPaise: 5_000,
    videoCostPaise: 1_000,
  });

  const t = await createTenant();
  tenantId = t.tenantId;
  clerkUserId = t.clerkUserId;
  actAs(clerkUserId);
});

afterAll(async () => {
  resetAuthState();
  await db.delete(walletLedgerTable).where(eq(walletLedgerTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
  await db.delete(walletSettingsTable);
  await db.delete(aiSpendSettingsTable);
  await deleteTenant(tenantId);
  await restoreAppCredentialRow("razorpay", credsSnapshot);
  mockServer.kill();
  await pool.end();
});

describe("wallet top-up round trip", () => {
  it("shows a GST-exclusive overview", async () => {
    const res = await request(app).get("/api/wallet");
    expect(res.status).toBe(200);
    expect(res.body.balancePaise).toBe(0);
    expect(res.body.gstPercent).toBe(18);
    // ₹2.00 + 20% platform fee.
    expect(res.body.rates.captionPaise).toBe(240);
    // Quota workspace: the UI hides the wallet entirely.
    expect(res.body.walletBilling).toBe(false);
  });

  it("refuses a top-up below the configured minimum", async () => {
    const res = await request(app).post("/api/wallet/recharge").send({ amountPaise: 5_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("minimum");
  });

  it("charges base + GST at checkout and credits only the base", async () => {
    const started = await request(app)
      .post("/api/wallet/recharge")
      .send({ amountPaise: 100_000 });
    expect(started.status).toBe(200);
    expect(started.body.basePaise).toBe(100_000);
    expect(started.body.gstPaise).toBe(18_000);
    // What Razorpay actually charges the card.
    expect(started.body.totalPaise).toBe(118_000);

    const orderId = started.body.razorpayOrderId as string;
    await fetch(`${MOCK_BASE}/orders/${orderId}/mark-paid`, { method: "POST" });

    const paymentId = `pay_${Date.now()}`;
    const verified = await request(app).post("/api/wallet/verify-recharge").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signOrder(orderId, paymentId),
    });
    expect(verified.status).toBe(200);
    // The GST went to the government, not the wallet.
    expect(verified.body.balancePaise).toBe(100_000);

    // Replaying the same order must not credit a second time.
    const replay = await request(app).post("/api/wallet/verify-recharge").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signOrder(orderId, paymentId),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.balancePaise).toBe(100_000);
  });

  it("rejects a forged signature", async () => {
    const started = await request(app)
      .post("/api/wallet/recharge")
      .send({ amountPaise: 100_000 });
    const orderId = started.body.razorpayOrderId as string;
    await fetch(`${MOCK_BASE}/orders/${orderId}/mark-paid`, { method: "POST" });

    const res = await request(app).post("/api/wallet/verify-recharge").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: "pay_forged",
      razorpaySignature: "deadbeef",
    });
    expect(res.status).toBe(400);
  });

  it("refuses to credit an order that was never paid", async () => {
    const started = await request(app)
      .post("/api/wallet/recharge")
      .send({ amountPaise: 100_000 });
    const orderId = started.body.razorpayOrderId as string;
    const paymentId = `pay_${Date.now()}_unpaid`;
    const res = await request(app).post("/api/wallet/verify-recharge").send({
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signOrder(orderId, paymentId),
    });
    expect(res.status).toBe(409);
  });
});
