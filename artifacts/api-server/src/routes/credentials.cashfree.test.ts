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

// Only the live network probe is stubbed; the DB persistence + audit logging
// stay real. The mock is toggled per-test to exercise verified/failed.
const testCashfreeMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/cashfree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cashfree")>();
  return { ...actual, testCashfreeCredentials: testCashfreeMock };
});
const testRazorpayMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/razorpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/razorpay")>();
  return { ...actual, testRazorpayCredentials: testRazorpayMock };
});

import { pool, type AppCredential } from "@workspace/db";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
  snapshotPaymentGatewaySettings,
  restorePaymentGatewaySettings,
  setPaymentGatewaySettings,
} from "../test/dbHelpers";
import { invalidateGatewayCache } from "../lib/paymentGateway";

const app = createAdminTestApp();
let superadminId: string;
let superTenantId: number;
let razorpaySnapshot: AppCredential | null = null;
let cashfreeSnapshot: AppCredential | null = null;
let gatewaySnapshot: Awaited<ReturnType<typeof snapshotPaymentGatewaySettings>>;

beforeAll(async () => {
  razorpaySnapshot = await snapshotAppCredentialRow("razorpay");
  cashfreeSnapshot = await snapshotAppCredentialRow("cashfree");
  gatewaySnapshot = await snapshotPaymentGatewaySettings();
  const t = await createTenant({ isSuperadmin: true });
  superadminId = t.clerkUserId;
  superTenantId = t.tenantId;
});

afterAll(async () => {
  resetAuthState();
  await restoreAppCredentialRow("razorpay", razorpaySnapshot);
  await restoreAppCredentialRow("cashfree", cashfreeSnapshot);
  await restorePaymentGatewaySettings(gatewaySnapshot);
  invalidateGatewayCache();
  await deleteTenant(superTenantId);
  await pool.end();
});

beforeEach(async () => {
  actAs(superadminId);
  testCashfreeMock.mockReset();
  testRazorpayMock.mockReset();
  // Shared global rows: reset to a clean baseline each test.
  await restoreAppCredentialRow("cashfree", null);
  await setPaymentGatewaySettings("razorpay");
  invalidateGatewayCache();
});

describe("Cashfree credentials admin route", () => {
  it("reports unconfigured before any keys are saved", async () => {
    const res = await request(app).get("/api/admin/platform-credentials/cashfree");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.appIdMasked).toBeNull();
  });

  it("saves keys, verifies them, and masks the stored values", async () => {
    testCashfreeMock.mockResolvedValue({ ok: true, error: null });
    const res = await request(app)
      .put("/api/admin/platform-credentials/cashfree")
      .send({ appId: "TEST_APP_ID_123456", secretKey: "cfsk_secret_value", mode: "sandbox" });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.mode).toBe("sandbox");
    expect(res.body.testStatus).toBe("verified");
    // Masked, never the raw secret.
    expect(res.body.secretKeyMasked).not.toContain("secret_value");
    expect(res.body.appIdMasked).toContain("3456");
  });

  it("persists a failed test status when the probe rejects the keys", async () => {
    testCashfreeMock.mockResolvedValue({ ok: false, error: "bad keys" });
    const res = await request(app)
      .put("/api/admin/platform-credentials/cashfree")
      .send({ appId: "APP", secretKey: "SECRET", mode: "production" });
    expect(res.status).toBe(200);
    expect(res.body.testStatus).toBe("failed");
    expect(res.body.testError).toBe("bad keys");
  });
});

describe("active payment gateway admin route", () => {
  it("reports the active gateway and configured flags", async () => {
    const res = await request(app).get("/api/admin/payment-gateway");
    expect(res.status).toBe(200);
    expect(res.body.activeGateway).toBe("razorpay");
    expect(res.body).toHaveProperty("razorpayConfigured");
    expect(res.body).toHaveProperty("cashfreeConfigured");
  });

  it("rejects switching to a gateway with no verified credentials", async () => {
    await restoreAppCredentialRow("cashfree", null);
    invalidateGatewayCache();
    const res = await request(app)
      .put("/api/admin/payment-gateway")
      .send({ activeGateway: "cashfree" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cashfree/);
  });

  it("switches once Cashfree keys exist", async () => {
    await setAppCredentialRow("cashfree", {
      appId: "APP",
      secretKey: "SECRET",
      mode: "sandbox",
    });
    invalidateGatewayCache();
    const res = await request(app)
      .put("/api/admin/payment-gateway")
      .send({ activeGateway: "cashfree" });
    expect(res.status).toBe(200);
    expect(res.body.activeGateway).toBe("cashfree");
  });
});
