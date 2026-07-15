import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Stub only the live-network Meta test calls; DB-backed helpers stay real.
vi.mock("./metaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metaApi")>();
  return {
    ...actual,
    testFacebookCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "Test Page",
    })),
    testInstagramCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "@testig",
    })),
  };
});

// A verified->failed transition emails the tenant via Clerk + SendGrid. Keep
// this DB-focused test hermetic: no live Clerk lookups, no real sends.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { pool } from "@workspace/db";
import { testFacebookCredentials } from "./metaApi";
import { sweepDeadConnections } from "./connectionSweep";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertLinkedinAccount,
  getConnectedAccount,
  getNotifications,
  setAccountState,
} from "../test/dbHelpers";

const mockFb = vi.mocked(testFacebookCredentials);

/** More than REVERIFY_STALE_MS (15 min) in the past. */
function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

beforeAll(() => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFb.mockResolvedValue({ ok: true, accountName: "Test Page" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sweepDeadConnections", () => {
  it("flips a stale, rejected Facebook token to failed and records one deduped notification", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok_1" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      mockFb.mockResolvedValue({
        ok: false,
        error: "Error validating access token: the token expired.",
      });

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");

      const afterFirst = await getNotifications(tenant.tenantId);
      expect(
        afterFirst.filter((n) => n.type === "social_connection_failed"),
      ).toHaveLength(1);

      // A second sweep of the already-known breakage must not duplicate spam.
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      await sweepDeadConnections();

      const afterSecond = await getNotifications(tenant.tenantId);
      expect(
        afterSecond.filter((n) => n.type === "social_connection_failed"),
      ).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("respects the staleness gate: a freshly-verified account is not re-tested", async () => {
    const tenant = await createTenant();
    try {
      // insertConnectedAccount stamps verifiedAt = now, i.e. fresh.
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok_1" },
        "verified",
      );

      await sweepDeadConnections();

      expect(mockFb).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flips a stale LinkedIn token rejected with 401 and notifies", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifiedAt: staleDate(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 401 })),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");

      const notifications = await getNotifications(tenant.tenantId);
      const li = notifications.filter(
        (n) => n.type === "social_connection_failed" && n.platform === "linkedin",
      );
      expect(li).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("never throws when one tenant's re-verify blows up, and still sweeps the rest", async () => {
    const broken = await createTenant();
    const healthy = await createTenant();
    try {
      await insertConnectedAccount(
        broken.tenantId,
        "facebook",
        { pageId: "PAGE_A", pageAccessToken: "tok_a" },
        "verified",
      );
      await setAccountState(broken.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      await insertConnectedAccount(
        healthy.tenantId,
        "facebook",
        { pageId: "PAGE_B", pageAccessToken: "tok_b" },
        "failed",
      );
      await setAccountState(healthy.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });

      // The broken tenant's check explodes; the other recovers to verified.
      // Keyed on the credentials so the test is independent of sweep order.
      mockFb.mockImplementation(async (creds: { pageId: string }) => {
        if (creds.pageId === "PAGE_A") throw new Error("unexpected crash");
        return { ok: true, accountName: "Page B" };
      });

      await expect(sweepDeadConnections()).resolves.toBeUndefined();
      expect(mockFb).toHaveBeenCalledTimes(2);

      const rows = await Promise.all([
        getConnectedAccount(broken.tenantId, "facebook"),
        getConnectedAccount(healthy.tenantId, "facebook"),
      ]);
      // The crashed check left the prior state untouched...
      expect(rows[0]?.verifyStatus).toBe("verified");
      // ...while the other tenant still got its recovery persisted.
      expect(rows[1]?.verifyStatus).toBe("verified");
      expect(rows[1]?.status).toBe("connected");
    } finally {
      await deleteTenant(broken.tenantId);
      await deleteTenant(healthy.tenantId);
    }
  });
});
