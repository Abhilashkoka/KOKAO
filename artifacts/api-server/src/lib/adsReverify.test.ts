import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Stub only the live-network ads reads; DB-backed helpers stay real.
vi.mock("./metaAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metaAdsApi")>();
  return {
    ...actual,
    readAdAccount: vi.fn(async () => ({ name: "Acct", currency: "USD" })),
  };
});
vi.mock("./tiktokAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tiktokAdsApi")>();
  return {
    ...actual,
    readAdvertiser: vi.fn(async () => ({ name: "Adv", currency: "USD" })),
  };
});
// The sweep also walks every social connection in the shared dev DB; stub
// the social reverifiers so this ads-focused test never hits live networks
// (REVERIFY_STALE_MS and the rest of the module stay real for adsReverify).
vi.mock("./socialReverify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./socialReverify")>();
  return {
    ...actual,
    reverifyFacebook: vi.fn(async () => undefined),
    reverifyInstagram: vi.fn(async () => undefined),
    reverifyLinkedin: vi.fn(async () => undefined),
    reverifyTwitter: vi.fn(async () => undefined),
    reverifyThreads: vi.fn(async () => undefined),
    reverifyYoutube: vi.fn(async () => undefined),
  };
});
// No live Clerk lookups or real emails in this DB-focused test.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { db, adAccountConnectionsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { MetaAdsApiError, readAdAccount } from "./metaAdsApi";
import { TiktokAdsApiError, readAdvertiser } from "./tiktokAdsApi";
import { encryptJson } from "./secretCrypto";
import {
  reverifyAdConnection,
  ADS_CREDENTIALS_UNREADABLE_MESSAGE,
  type AdSweepPlatform,
} from "./adsReverify";
import { sweepDeadConnections } from "./connectionSweep";
import {
  createTenant,
  deleteTenant,
  getNotifications,
} from "../test/dbHelpers";

const mockReadAdAccount = vi.mocked(readAdAccount);
const mockReadAdvertiser = vi.mocked(readAdvertiser);

/** More than REVERIFY_STALE_MS (15 min) in the past. */
function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

async function insertAdConnection(
  tenantId: number,
  platform: AdSweepPlatform,
  overrides: Partial<typeof adAccountConnectionsTable.$inferInsert> = {},
) {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform,
      adAccountId: platform === "meta" ? "act_123" : "adv_123",
      adAccountName: "Test Account",
      status: "connected",
      encryptedCredentials: encryptJson({ accessToken: "tok_ads" }),
      verifyStatus: "verified",
      verifiedAt: staleDate(),
      ...overrides,
    })
    .returning();
  return row;
}

async function getAdConnectionRow(tenantId: number, platform: string) {
  return (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
}

async function cleanupTenant(tenantId: number) {
  await db
    .delete(adAccountConnectionsTable)
    .where(eq(adAccountConnectionsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
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
  mockReadAdAccount.mockResolvedValue({ name: "Acct", currency: "USD" });
  mockReadAdvertiser.mockResolvedValue({ name: "Adv", currency: "USD" });
});

describe("reverifyAdConnection", () => {
  it("flips a stale Meta connection with a revoked token to failed and notifies once", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta");
      mockReadAdAccount.mockRejectedValue(
        new MetaAdsApiError("Error validating access token", 401, true),
      );

      const outcome = await reverifyAdConnection(tenant.tenantId, "meta");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });

      const row = await getAdConnectionRow(tenant.tenantId, "meta");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("Error validating access token");

      const notifications = await getNotifications(tenant.tenantId);
      const alerts = notifications.filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("meta");
      expect(alerts[0].linkUrl).toBe("/ads");

      // A repeat check while still broken stays deduped (already failed, and
      // the unread notification guards a second insert either way).
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: staleDate() })
        .where(eq(adAccountConnectionsTable.tenantId, tenant.tenantId));
      await reverifyAdConnection(tenant.tenantId, "meta");
      const after = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(after).toHaveLength(1);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("flips a TikTok connection to failed when the advertiser grant is revoked (auth error)", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "tiktok");
      mockReadAdvertiser.mockRejectedValue(
        new TiktokAdsApiError("Access token expired", 200, 40105, true),
      );

      const outcome = await reverifyAdConnection(tenant.tenantId, "tiktok");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "tiktok");
      expect(row?.verifyStatus).toBe("failed");
      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("tiktok");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("treats TikTok no-longer-returning the advertiser (404) as a definitive failure", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "tiktok");
      mockReadAdvertiser.mockRejectedValue(
        new TiktokAdsApiError(
          "TikTok did not return that advertiser account for this grant.",
          404,
          -1,
        ),
      );

      const outcome = await reverifyAdConnection(tenant.tenantId, "tiktok");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "tiktok");
      expect(row?.verifyStatus).toBe("failed");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("does not flip status on a transient failure, only touches the clock and rethrows", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta");
      mockReadAdAccount.mockRejectedValue(
        new MetaAdsApiError("Service temporarily unavailable", 503, false),
      );

      await expect(
        reverifyAdConnection(tenant.tenantId, "meta"),
      ).rejects.toThrow("Service temporarily unavailable");

      const row = await getAdConnectionRow(tenant.tenantId, "meta");
      expect(row?.verifyStatus).toBe("verified");
      // Clock was reset so the next sweep cycle won't hammer during an outage.
      expect(row?.verifiedAt && Date.now() - row.verifiedAt.getTime()).toBeLessThan(
        60 * 1000,
      );
      expect(await getNotifications(tenant.tenantId)).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("skips fresh connections unless forced", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta", {
        verifiedAt: new Date(),
      });
      const outcome = await reverifyAdConnection(tenant.tenantId, "meta");
      expect(outcome).toEqual({ checked: false, reason: "fresh" });
      expect(mockReadAdAccount).not.toHaveBeenCalled();

      const forced = await reverifyAdConnection(tenant.tenantId, "meta", {
        force: true,
      });
      expect(forced).toEqual({ checked: true, verifyStatus: "verified" });
      expect(mockReadAdAccount).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("skips pending-selection rows (no ad account picked yet)", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta", {
        status: "pending_selection",
        adAccountId: "",
        verifyStatus: null,
        verifiedAt: null,
      });
      const outcome = await reverifyAdConnection(tenant.tenantId, "meta");
      expect(outcome).toEqual({ checked: false, reason: "pending_selection" });
      expect(mockReadAdAccount).not.toHaveBeenCalled();
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("fails a connection whose stored credentials cannot be decrypted", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta", {
        encryptedCredentials: "v1:garbage",
      });
      const outcome = await reverifyAdConnection(tenant.tenantId, "meta");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "meta");
      expect(row?.verifyError).toBe(ADS_CREDENTIALS_UNREADABLE_MESSAGE);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("resolves the reconnect notification when the grant verifies again", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta");
      mockReadAdAccount.mockRejectedValueOnce(
        new MetaAdsApiError("token revoked", 401, true),
      );
      await reverifyAdConnection(tenant.tenantId, "meta");
      let alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed" && n.readAt == null,
      );
      expect(alerts).toHaveLength(1);

      // Grant works again (e.g. user reconnected) — next stale check clears it.
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: staleDate() })
        .where(eq(adAccountConnectionsTable.tenantId, tenant.tenantId));
      const outcome = await reverifyAdConnection(tenant.tenantId, "meta");
      expect(outcome).toEqual({ checked: true, verifyStatus: "verified" });

      alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed" && n.readAt == null,
      );
      expect(alerts).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });
});

describe("sweep integration", () => {
  it("checks connected ad connections during a sweep and flips revoked grants", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "meta");
      await insertAdConnection(tenant.tenantId, "tiktok");
      mockReadAdAccount.mockRejectedValue(
        new MetaAdsApiError("token revoked", 401, true),
      );

      await sweepDeadConnections();

      const metaRow = await getAdConnectionRow(tenant.tenantId, "meta");
      expect(metaRow?.verifyStatus).toBe("failed");
      const tiktokRow = await getAdConnectionRow(tenant.tenantId, "tiktok");
      expect(tiktokRow?.verifyStatus).toBe("verified");

      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("meta");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("records a transient ads failure in the sweep error bookkeeping with an -ads key", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "tiktok");
      mockReadAdvertiser.mockRejectedValue(
        new TiktokAdsApiError("TikTok is unavailable", 503, 50000),
      );

      const outcome = await sweepDeadConnections();

      const key = `${tenant.tenantId}:tiktok-ads`;
      expect(outcome.failStreaks[key]?.count).toBeGreaterThanOrEqual(1);
      expect(
        outcome.recentFailures.some(
          (f) => f.tenantId === tenant.tenantId && f.platform === "tiktok-ads",
        ),
      ).toBe(true);
      const row = await getAdConnectionRow(tenant.tenantId, "tiktok");
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });
});
