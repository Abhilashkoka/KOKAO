import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Stub only the live-network Meta Ads read; DB-backed helpers stay real.
vi.mock("./metaAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metaAdsApi")>();
  return {
    ...actual,
    readAdAccount: vi.fn(async () => ({ name: "Test Ad Account", currency: "USD" })),
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

// The sweep-integration tests below run the real sweep, which also visits
// other tenants' leftover social rows in the shared dev DB. Stub the social
// reverifiers so those rows never trigger live network calls; keep the real
// REVERIFY_STALE_MS since adsReverify's staleness gate depends on it.
vi.mock("./socialReverify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./socialReverify")>();
  return {
    ...actual,
    reverifyFacebook: vi.fn(async () => null),
    reverifyInstagram: vi.fn(async () => null),
    reverifyLinkedin: vi.fn(async () => null),
    reverifyTwitter: vi.fn(async () => null),
    reverifyThreads: vi.fn(async () => null),
    reverifyYoutube: vi.fn(async () => null),
  };
});

import { pool, db, adAccountConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { readAdAccount, MetaAdsApiError } from "./metaAdsApi";
import { reverifyMetaAds } from "./adsReverify";
import { sweepDeadConnections } from "./connectionSweep";
import { encryptJson } from "./secretCrypto";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  type TestTenant,
} from "../test/dbHelpers";

const mockRead = vi.mocked(readAdAccount);

/** More than REVERIFY_STALE_MS (15 min) in the past. */
function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

async function insertAdConnection(
  tenantId: number,
  opts: {
    verifyStatus?: string | null;
    verifiedAt?: Date | null;
    adAccountId?: string;
  } = {},
): Promise<number> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform: "meta",
      adAccountId: opts.adAccountId ?? "act_123",
      adAccountName: "Old Name",
      status: "connected",
      encryptedCredentials: encryptJson({ accessToken: "ads_tok" }),
      verifyStatus: opts.verifyStatus === undefined ? "verified" : opts.verifyStatus,
      verifiedAt: opts.verifiedAt === undefined ? staleDate() : opts.verifiedAt,
    })
    .returning({ id: adAccountConnectionsTable.id });
  return row.id;
}

async function getAdConnection(id: number) {
  return (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(eq(adAccountConnectionsTable.id, id))
      .limit(1)
  )[0];
}

async function cleanupTenant(tenant: TestTenant): Promise<void> {
  await db
    .delete(adAccountConnectionsTable)
    .where(eq(adAccountConnectionsTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
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
  mockRead.mockResolvedValue({ name: "Test Ad Account", currency: "USD" });
});

describe("reverifyMetaAds", () => {
  it("flips a stale connection with a dead token to failed and records one deduped notification", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertAdConnection(tenant.tenantId);
      mockRead.mockRejectedValue(
        new MetaAdsApiError("Error validating access token: expired.", 400, true),
      );

      const first = await reverifyMetaAds(tenant.tenantId);
      expect(first).toEqual({ checked: true, verifyStatus: "failed" });

      const row = await getAdConnection(id);
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("expired");

      const notes = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].platform).toBe("meta");
      expect(notes[0].linkUrl).toBe("/ads");

      // Second check while still broken: no duplicate notification.
      await reverifyMetaAds(tenant.tenantId, true);
      const after = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(after).toHaveLength(1);
    } finally {
      await cleanupTenant(tenant);
    }
  });

  it("does not flip on a transient error; only touches the checked clock", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertAdConnection(tenant.tenantId);
      mockRead.mockRejectedValue(new MetaAdsApiError("Service temporarily unavailable", 503, false));

      await expect(reverifyMetaAds(tenant.tenantId)).rejects.toThrow(
        "Service temporarily unavailable",
      );

      const row = await getAdConnection(id);
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.verifiedAt && row.verifiedAt.getTime()).toBeGreaterThan(
        Date.now() - 60 * 1000,
      );
      expect(
        (await getNotifications(tenant.tenantId)).filter(
          (n) => n.type === "ads_connection_failed",
        ),
      ).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant);
    }
  });

  it("skips fresh connections unless forced, and skips pending selections entirely", async () => {
    const tenant = await createTenant();
    try {
      const freshId = await insertAdConnection(tenant.tenantId, {
        verifiedAt: new Date(),
      });
      expect(await reverifyMetaAds(tenant.tenantId)).toEqual({
        checked: false,
        verifyStatus: "verified",
      });
      expect(mockRead).not.toHaveBeenCalled();

      // Forced check bypasses the staleness gate.
      expect(await reverifyMetaAds(tenant.tenantId, true)).toEqual({
        checked: true,
        verifyStatus: "verified",
      });

      // No ad account picked yet -> nothing verifiable.
      await db
        .update(adAccountConnectionsTable)
        .set({ adAccountId: "" })
        .where(eq(adAccountConnectionsTable.id, freshId));
      mockRead.mockClear();
      expect((await reverifyMetaAds(tenant.tenantId, true)).checked).toBe(false);
      expect(mockRead).not.toHaveBeenCalled();
    } finally {
      await cleanupTenant(tenant);
    }
  });

  it("re-verifying successfully refreshes the name and resolves the breakage notification", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertAdConnection(tenant.tenantId, {
        verifyStatus: "failed",
      });
      // Seed an unread breakage notification as if a prior sweep flagged it.
      const { notifyAdsConnectionFailed } = await import("./notifications");
      await notifyAdsConnectionFailed(tenant.tenantId, "meta", "token dead");

      const outcome = await reverifyMetaAds(tenant.tenantId);
      expect(outcome).toEqual({ checked: true, verifyStatus: "verified" });

      const row = await getAdConnection(id);
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.adAccountName).toBe("Test Ad Account");
      expect(row?.verifyError).toBeNull();

      const unread = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed" && n.readAt === null,
      );
      expect(unread).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant);
    }
  });
});

describe("connection sweep covers ad account connections", () => {
  it("the sweep flips a stale dead ads token to failed and notifies the tenant", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertAdConnection(tenant.tenantId);
      mockRead.mockRejectedValue(
        new MetaAdsApiError("Error validating access token: expired.", 400, true),
      );

      const result = await sweepDeadConnections();
      // A definitive auth rejection is handled INSIDE the reverify (row
      // flipped + tenant notified) — it is not a sweep-level error.
      expect(result.accountsChecked).toBeGreaterThanOrEqual(1);

      const row = await getAdConnection(id);
      expect(row?.verifyStatus).toBe("failed");

      const notes = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(notes).toHaveLength(1);
    } finally {
      await cleanupTenant(tenant);
    }
  });

  it("a transient ads failure is recorded in the sweep's failure bookkeeping under meta_ads", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertAdConnection(tenant.tenantId);
      mockRead.mockRejectedValue(new MetaAdsApiError("Timeout talking to Meta", 504, false));

      const result = await sweepDeadConnections();
      const failure = result.recentFailures.find(
        (f) => f.tenantId === tenant.tenantId && f.platform === "meta_ads",
      );
      expect(failure).toBeDefined();
      expect(result.failStreaks[`${tenant.tenantId}:meta_ads`]?.count).toBe(1);

      // Transient: row stays verified.
      const row = await getAdConnection(id);
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await cleanupTenant(tenant);
    }
  });
});
