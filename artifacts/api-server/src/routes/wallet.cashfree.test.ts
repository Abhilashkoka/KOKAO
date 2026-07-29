/**
 * Cashfree-specific wallet behavior:
 *   (a) GET /wallet reports configured:true when Cashfree is the ACTIVE gateway
 *       and Razorpay is unconfigured, and keyId stays null (Razorpay-only).
 *   (b) POST /wallet/verify-recharge rejects a PAID Cashfree order whose
 *       canonical amount doesn't match the tagged base+GST split — never
 *       crediting the wallet.
 *
 * The Cashfree + Razorpay lib layers are stubbed so we control "configured"
 * state and the canonical re-fetched order without any network. DB writes,
 * the gateway switch, and the amount cross-check stay real.
 */
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

// Razorpay is UNCONFIGURED in these tests; Cashfree is active + configured.
vi.mock("../lib/razorpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/razorpay")>();
  return {
    ...actual,
    isRazorpayConfigured: vi.fn(async () => false),
    getRazorpayKeyId: vi.fn(async () => null),
  };
});

const getOrderMock = vi.hoisted(() => vi.fn());
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
    getCashfreeOrder: getOrderMock,
  };
});

import {
  pool,
  db,
  walletBalancesTable,
  walletLedgerTable,
  walletSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import walletRouter from "./wallet";
import { setWalletConfig } from "../lib/wallet";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  snapshotPaymentGatewaySettings,
  restorePaymentGatewaySettings,
  setPaymentGatewaySettings,
  snapshotWalletSettings,
  restoreWalletSettings,
} from "../test/dbHelpers";
import { invalidateGatewayCache } from "../lib/paymentGateway";
import type { WalletSettings } from "@workspace/db";

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

const app = buildApp();
let gatewaySnapshot: Awaited<ReturnType<typeof snapshotPaymentGatewaySettings>>;
let walletSnapshot: WalletSettings | null = null;
let tenantId: number;
let clerkUserId: string;

beforeAll(async () => {
  gatewaySnapshot = await snapshotPaymentGatewaySettings();
  walletSnapshot = await snapshotWalletSettings();
  await setWalletConfig({
    gstPercent: 18,
    minTopupPaise: 10_000,
    lowBalanceThresholdPaise: 5_000,
    videoCostPaise: 0,
  });
  const t = await createTenant();
  tenantId = t.tenantId;
  clerkUserId = t.clerkUserId;
});

afterAll(async () => {
  resetAuthState();
  await db.delete(walletLedgerTable).where(eq(walletLedgerTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
  await restoreWalletSettings(walletSnapshot);
  await restorePaymentGatewaySettings(gatewaySnapshot);
  invalidateGatewayCache();
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  actAs(clerkUserId);
  getOrderMock.mockReset();
  await setPaymentGatewaySettings("cashfree");
  invalidateGatewayCache();
  await db.delete(walletLedgerTable).where(eq(walletLedgerTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
});

describe("GET /wallet gateway-awareness", () => {
  it("reports configured:true with active=cashfree even when Razorpay is unconfigured", async () => {
    const res = await request(app).get("/api/wallet");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    // keyId is a Razorpay-only concept and must be null when Cashfree is active.
    expect(res.body.keyId).toBeNull();
  });
});

describe("POST /wallet/verify-recharge amount integrity (Cashfree)", () => {
  it("rejects a PAID order whose amount doesn't match the tagged split", async () => {
    // Tagged split says base 1000 + GST 180 = 1180 rupees, but Cashfree only
    // charged 1000 rupees. The cross-check must reject and never credit.
    getOrderMock.mockResolvedValue({
      order_id: "cf_wallet_mismatch",
      order_amount: 1000,
      order_currency: "INR",
      order_status: "PAID",
      order_tags: {
        purpose: "wallet_topup",
        tenantId: String(tenantId),
        basePaise: "100000",
        gstPaise: "18000",
        gstPercent: "18",
      },
    });
    const res = await request(app)
      .post("/api/wallet/verify-recharge")
      .send({ cashfreeOrderId: "cf_wallet_mismatch" });
    expect(res.status).toBe(400);
    const ledger = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.tenantId, tenantId));
    expect(ledger.length).toBe(0);
    const bal = await db
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, tenantId));
    expect(bal.length).toBe(0);
  });

  it("credits when the PAID order amount matches the tagged split", async () => {
    getOrderMock.mockResolvedValue({
      order_id: "cf_wallet_ok",
      order_amount: 1180,
      order_currency: "INR",
      order_status: "PAID",
      order_tags: {
        purpose: "wallet_topup",
        tenantId: String(tenantId),
        basePaise: "100000",
        gstPaise: "18000",
        gstPercent: "18",
      },
    });
    const res = await request(app)
      .post("/api/wallet/verify-recharge")
      .send({ cashfreeOrderId: "cf_wallet_ok" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Only the BASE lands in the wallet.
    expect(res.body.balancePaise).toBe(100000);
  });
});
