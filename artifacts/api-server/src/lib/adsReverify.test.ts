import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Sweeps walk the whole shared dev DB; under a full parallel monorepo test
// run the DB is heavily loaded and individual sweep tests can exceed the 30s
// default. Load-related slowness is not a failure.
vi.setConfig({ testTimeout: 120_000 });

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
// Stub only the live-network Google Ads calls; GoogleAdsApiError stays real
// so authFailed classification is exercised. Leftover google rows from other
// tests in the shared dev DB must never trigger live token refreshes either.
vi.mock("./googleAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./googleAdsApi")>();
  return {
    ...actual,
    getGoogleAdsAuth: vi.fn(async () => ({
      accessToken: "g_tok",
      developerToken: "dev_tok",
      customerId: "1234567890",
      loginCustomerId: null,
    })),
    readCustomer: vi.fn(async () => ({ name: "Google Acct", currency: "USD" })),
  };
});
// Stub only the live-network LinkedIn ads read; error class stays real so
// the auth-failure gate is exercised.
vi.mock("./linkedinAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./linkedinAdsApi")>();
  return {
    ...actual,
    readLinkedinAdAccount: vi.fn(async () => ({
      name: "LI Acct",
      currency: "USD",
    })),
  };
});
// The LinkedIn silent-refresh gate talks to the token endpoint through
// platformFetch; stub it (and the app-credential lookup) so refresh attempts
// never hit the network.
vi.mock("./platformFetch", () => ({
  platformFetch: vi.fn(),
}));
vi.mock("./linkedinApp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./linkedinApp")>();
  return {
    ...actual,
    getLinkedinAppCredentials: vi.fn(async () => ({
      clientId: "app-id",
      clientSecret: "app-secret",
    })),
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
import { GoogleAdsApiError, getGoogleAdsAuth, readCustomer } from "./googleAdsApi";
import { LinkedinAdsApiError, readLinkedinAdAccount } from "./linkedinAdsApi";
import { platformFetch } from "./platformFetch";
import { encryptJson } from "./secretCrypto";
import {
  reverifyAdConnection,
  ADS_CREDENTIALS_UNREADABLE_MESSAGE,
  LINKEDIN_ADS_TOKEN_EXPIRED_MESSAGE,
  type AdSweepPlatform,
} from "./adsReverify";
import { sweepDeadConnections } from "./connectionSweep";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  acquireSweepTestLock,
  releaseSweepTestLock,
} from "../test/dbHelpers";

const mockReadAdAccount = vi.mocked(readAdAccount);
const mockReadAdvertiser = vi.mocked(readAdvertiser);
const mockReadLinkedinAdAccount = vi.mocked(readLinkedinAdAccount);
const mockPlatformFetch = vi.mocked(platformFetch);
const mockGetGoogleAdsAuth = vi.mocked(getGoogleAdsAuth);
const mockReadCustomer = vi.mocked(readCustomer);

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

beforeAll(async () => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
  // Serialize with the other sweep-running suites (see dbHelpers).
  await acquireSweepTestLock();
}, 600_000);

afterAll(async () => {
  await releaseSweepTestLock();
  await pool.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockReadAdAccount.mockResolvedValue({ name: "Acct", currency: "USD" });
  mockReadAdvertiser.mockResolvedValue({ name: "Adv", currency: "USD" });
  mockGetGoogleAdsAuth.mockResolvedValue({
    accessToken: "g_tok",
    developerToken: "dev_tok",
    customerId: "1234567890",
    loginCustomerId: null,
  });
  mockReadCustomer.mockResolvedValue({ name: "Google Acct", currency: "USD" });
  mockReadLinkedinAdAccount.mockResolvedValue({
    name: "LI Acct",
    currency: "USD",
  });
  mockPlatformFetch.mockRejectedValue(new Error("unexpected network call"));
});

const DAY = 24 * 60 * 60 * 1000;

function linkedinCreds(
  overrides: Partial<{
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
    refreshTokenExpiresAt: number;
  }> = {},
) {
  return {
    accessToken: "li_tok",
    // Far from expiry so the silent refresher stays idle by default.
    expiresAt: Date.now() + 30 * DAY,
    ...overrides,
  };
}

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

  it("flips a Google connection to failed when the refresh token is revoked and notifies", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "google", {
        adAccountId: "1234567890",
        encryptedCredentials: encryptJson({ refreshToken: "rt_revoked" }),
      });
      mockGetGoogleAdsAuth.mockRejectedValue(
        new GoogleAdsApiError(
          "Google rejected the stored connection (invalid_grant). Reconnect the ad account.",
          400,
          true,
        ),
      );

      const outcome = await reverifyAdConnection(tenant.tenantId, "google");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "google");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("invalid_grant");

      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("google");
      expect(alerts[0].linkUrl).toBe("/ads");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("flips a Google connection to failed on lost customer access (authFailed read)", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "google", {
        adAccountId: "1234567890",
        encryptedCredentials: encryptJson({ refreshToken: "rt_ok" }),
      });
      mockReadCustomer.mockRejectedValue(
        new GoogleAdsApiError("PERMISSION_DENIED", 403, true),
      );

      const outcome = await reverifyAdConnection(tenant.tenantId, "google");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "google");
      expect(row?.verifyStatus).toBe("failed");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("does not flip a Google connection on a transient failure, only touches the clock", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "google", {
        adAccountId: "1234567890",
        encryptedCredentials: encryptJson({ refreshToken: "rt_ok" }),
      });
      mockReadCustomer.mockRejectedValue(
        new GoogleAdsApiError("Internal error", 500, false),
      );

      await expect(
        reverifyAdConnection(tenant.tenantId, "google"),
      ).rejects.toThrow("Internal error");

      const row = await getAdConnectionRow(tenant.tenantId, "google");
      expect(row?.verifyStatus).toBe("verified");
      expect(
        row?.verifiedAt && Date.now() - row.verifiedAt.getTime(),
      ).toBeLessThan(60 * 1000);
      expect(await getNotifications(tenant.tenantId)).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("re-verifies a healthy Google grant and refreshes account metadata", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "google", {
        adAccountId: "1234567890",
        adAccountName: "Old Name",
        encryptedCredentials: encryptJson({ refreshToken: "rt_ok" }),
      });
      const outcome = await reverifyAdConnection(tenant.tenantId, "google");
      expect(outcome).toEqual({ checked: true, verifyStatus: "verified" });
      const row = await getAdConnectionRow(tenant.tenantId, "google");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.adAccountName).toBe("Google Acct");
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

describe("reverifyAdConnection (linkedin)", () => {
  async function insertLinkedin(
    tenantId: number,
    creds: Record<string, unknown>,
    overrides: Partial<typeof adAccountConnectionsTable.$inferInsert> = {},
  ) {
    return insertAdConnection(tenantId, "linkedin", {
      adAccountId: "512345678",
      encryptedCredentials: encryptJson(creds),
      ...overrides,
    });
  }

  it("re-verifies a healthy LinkedIn grant and refreshes account metadata", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(tenant.tenantId, linkedinCreds(), {
        adAccountName: "Old LI Name",
      });
      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "verified" });
      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.adAccountName).toBe("LI Acct");
      expect(mockReadLinkedinAdAccount).toHaveBeenCalledWith(
        "li_tok",
        "512345678",
      );
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("fails a timestamp-expired token without a refresh token via the stored expiry (no live call) and notifies once", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(
        tenant.tenantId,
        linkedinCreds({ expiresAt: Date.now() - DAY }),
      );
      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      expect(mockReadLinkedinAdAccount).not.toHaveBeenCalled();

      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toBe(LINKEDIN_ADS_TOKEN_EXPIRED_MESSAGE);

      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("linkedin");
      expect(alerts[0].linkUrl).toBe("/ads");

      // A repeat check while still broken stays deduped.
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: staleDate() })
        .where(eq(adAccountConnectionsTable.tenantId, tenant.tenantId));
      await reverifyAdConnection(tenant.tenantId, "linkedin");
      const after = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(after).toHaveLength(1);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("flips to failed and notifies when the probe 401s and there is no refresh token", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(tenant.tenantId, linkedinCreds());
      mockReadLinkedinAdAccount.mockRejectedValue(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );

      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("failed");

      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("linkedin");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("does not demote on a probe 401 when the refresh gate renews the token", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(
        tenant.tenantId,
        linkedinCreds({ refreshToken: "rt_ok" }),
      );
      mockReadLinkedinAdAccount.mockRejectedValue(
        new LinkedinAdsApiError("Stale token", 401, true),
      );
      mockPlatformFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "li_tok_new", expires_in: 5184000 }),
      } as unknown as Response);

      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "verified" });
      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("verified");
      expect(await getNotifications(tenant.tenantId)).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("flips to failed and notifies when the probe 401s and the refresh token is definitively rejected", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(
        tenant.tenantId,
        linkedinCreds({ refreshToken: "rt_dead" }),
      );
      mockReadLinkedinAdAccount.mockRejectedValue(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );
      mockPlatformFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      } as unknown as Response);

      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("failed");

      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("linkedin");
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("does not flip on a transient probe failure, only touches the clock and rethrows", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(tenant.tenantId, linkedinCreds());
      mockReadLinkedinAdAccount.mockRejectedValue(
        new LinkedinAdsApiError("LinkedIn is unavailable", 503, false),
      );

      await expect(
        reverifyAdConnection(tenant.tenantId, "linkedin"),
      ).rejects.toThrow("LinkedIn is unavailable");

      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("verified");
      expect(
        row?.verifiedAt && Date.now() - row.verifiedAt.getTime(),
      ).toBeLessThan(60 * 1000);
      expect(await getNotifications(tenant.tenantId)).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("fails a connection whose stored credentials cannot be decrypted", async () => {
    const tenant = await createTenant();
    try {
      await insertAdConnection(tenant.tenantId, "linkedin", {
        adAccountId: "512345678",
        encryptedCredentials: "v1:garbage",
      });
      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "failed" });
      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyError).toBe(ADS_CREDENTIALS_UNREADABLE_MESSAGE);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("resolves the reconnect notification when the grant verifies again", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(tenant.tenantId, linkedinCreds());
      mockReadLinkedinAdAccount.mockRejectedValueOnce(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );
      await reverifyAdConnection(tenant.tenantId, "linkedin");
      let alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed" && n.readAt == null,
      );
      expect(alerts).toHaveLength(1);

      // Grant works again (e.g. user reconnected) — next stale check clears it.
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: staleDate() })
        .where(eq(adAccountConnectionsTable.tenantId, tenant.tenantId));
      const outcome = await reverifyAdConnection(tenant.tenantId, "linkedin");
      expect(outcome).toEqual({ checked: true, verifyStatus: "verified" });

      alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed" && n.readAt == null,
      );
      expect(alerts).toHaveLength(0);
    } finally {
      await cleanupTenant(tenant.tenantId);
    }
  });

  it("checks LinkedIn ad connections during a sweep and flips revoked grants", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedin(tenant.tenantId, linkedinCreds());
      mockReadLinkedinAdAccount.mockRejectedValue(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );

      await sweepDeadConnections();

      const row = await getAdConnectionRow(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("failed");
      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].platform).toBe("linkedin");
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
      await insertAdConnection(tenant.tenantId, "google", {
        adAccountId: "1234567890",
        encryptedCredentials: encryptJson({ refreshToken: "rt_ok" }),
      });
      mockReadAdAccount.mockRejectedValue(
        new MetaAdsApiError("token revoked", 401, true),
      );
      mockGetGoogleAdsAuth.mockRejectedValue(
        new GoogleAdsApiError("invalid_grant", 400, true),
      );

      await sweepDeadConnections();

      const metaRow = await getAdConnectionRow(tenant.tenantId, "meta");
      expect(metaRow?.verifyStatus).toBe("failed");
      const tiktokRow = await getAdConnectionRow(tenant.tenantId, "tiktok");
      expect(tiktokRow?.verifyStatus).toBe("verified");
      const googleRow = await getAdConnectionRow(tenant.tenantId, "google");
      expect(googleRow?.verifyStatus).toBe("failed");

      const alerts = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(alerts).toHaveLength(2);
      expect(alerts.map((a) => a.platform).sort()).toEqual(["google", "meta"]);
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
