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
import {
  sweepDeadConnections,
  recordSweepRun,
  triggerSweepNow,
  isSweepRunning,
  checkSweepStaleness,
} from "./connectionSweep";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertLinkedinAccount,
  insertThreadsAccount,
  getConnectedAccount,
  getNotifications,
  setAccountState,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
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

  it("flips a stale Threads token rejected by the live probe and notifies once", async () => {
    const tenant = await createTenant();
    try {
      // No expiry timestamp -> the sweep uses the live /me probe path.
      await insertThreadsAccount(tenant.tenantId, {
        verifiedAt: staleDate(),
        tokenExpiresAt: null,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 401 })),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");

      const notifications = await getNotifications(tenant.tenantId);
      expect(
        notifications.filter(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "threads",
        ),
      ).toHaveLength(1);

      // A second sweep of the known breakage produces no duplicate spam.
      await setAccountState(tenant.tenantId, "threads", {
        verifiedAt: staleDate(),
      });
      await sweepDeadConnections();
      const after = await getNotifications(tenant.tenantId);
      expect(
        after.filter(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "threads",
        ),
      ).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flips a stale Threads token already expired by timestamp without a live call", async () => {
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        verifiedAt: staleDate(),
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");
      expect(fetchSpy).not.toHaveBeenCalled();

      const notifications = await getNotifications(tenant.tenantId);
      expect(
        notifications.filter(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "threads",
        ),
      ).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("refreshes a Threads token inside the renewal window and keeps it verified", async () => {
    const tenant = await createTenant();
    try {
      // Expires in 2 days -> inside the 7-day renewal window.
      await insertThreadsAccount(tenant.tenantId, {
        verifiedAt: staleDate(),
        tokenExpiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                access_token: "th_tok_refreshed",
                expires_in: 60 * 24 * 60 * 60,
              }),
              { status: 200 },
            ),
        ),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.status).toBe("connected");
      expect(row?.accessToken).toBe("th_tok_refreshed");
      expect(row?.tokenExpiresAt!.getTime()).toBeGreaterThan(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flips a stale YouTube connection whose refresh token Google rejects, and notifies", async () => {
    const tenant = await createTenant();
    const snapshot = await snapshotAppCredentialRow("youtube");
    try {
      await setAppCredentialRow("youtube", {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      });
      await insertConnectedAccount(
        tenant.tenantId,
        "youtube",
        { refreshToken: "yt_refresh_tok" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "youtube", {
        verifiedAt: staleDate(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "invalid_grant" }), {
              status: 400,
            }),
        ),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");

      const notifications = await getNotifications(tenant.tenantId);
      expect(
        notifications.filter(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "youtube",
        ),
      ).toHaveLength(1);
    } finally {
      await restoreAppCredentialRow("youtube", snapshot);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("re-verifies a stale YouTube connection whose refresh succeeds, persisting the fresh token", async () => {
    const tenant = await createTenant();
    const snapshot = await snapshotAppCredentialRow("youtube");
    try {
      await setAppCredentialRow("youtube", {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      });
      await insertConnectedAccount(
        tenant.tenantId,
        "youtube",
        { refreshToken: "yt_refresh_tok" },
        "failed",
      );
      await setAccountState(tenant.tenantId, "youtube", {
        verifiedAt: staleDate(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ access_token: "yt_tok_fresh", expires_in: 3600 }),
              { status: 200 },
            ),
        ),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.status).toBe("connected");
      expect(row?.accessToken).toBe("yt_tok_fresh");
    } finally {
      await restoreAppCredentialRow("youtube", snapshot);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("re-verifies YouTube using env-var app credentials when no DB row exists", async () => {
    const tenant = await createTenant();
    const snapshot = await snapshotAppCredentialRow("youtube");
    try {
      // No DB app-credential row — only the env fallback is configured.
      await restoreAppCredentialRow("youtube", null);
      vi.stubEnv("GOOGLE_CLIENT_ID", "env-google-client-id");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "env-google-client-secret");

      await insertConnectedAccount(
        tenant.tenantId,
        "youtube",
        { refreshToken: "yt_refresh_tok" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "youtube", {
        verifiedAt: staleDate(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "invalid_grant" }), {
              status: 400,
            }),
        ),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");

      const notifications = await getNotifications(tenant.tenantId);
      expect(
        notifications.filter(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "youtube",
        ),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      await restoreAppCredentialRow("youtube", snapshot);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("YouTube transient refresh error only resets the clock, never flips a valid connection", async () => {
    const tenant = await createTenant();
    const snapshot = await snapshotAppCredentialRow("youtube");
    try {
      await setAppCredentialRow("youtube", {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      });
      await insertConnectedAccount(
        tenant.tenantId,
        "youtube",
        { refreshToken: "yt_refresh_tok" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "youtube", {
        verifiedAt: staleDate(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 503 })),
      );

      await sweepDeadConnections();

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.status).toBe("connected");
      // The clock was reset so the next sweep won't immediately re-test.
      expect(Date.now() - row!.verifiedAt!.getTime()).toBeLessThan(60 * 1000);
    } finally {
      await restoreAppCredentialRow("youtube", snapshot);
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

      const outcome = await sweepDeadConnections();
      // The crash is counted, not thrown. The shared dev DB may hold other
      // tenants' rows, so assert lower bounds rather than exact counts.
      expect(outcome.errorCount).toBeGreaterThanOrEqual(1);
      expect(outcome.accountsChecked).toBeGreaterThanOrEqual(2);
      expect(outcome.lastError).toContain("unexpected crash");
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

describe("checkSweepStaleness", () => {
  it("alerts a superadmin tenant once (deduped) when the last run is stale, and not a regular tenant", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      // Seed a last run well past the 35-minute threshold.
      await recordSweepRun(new Date(Date.now() - 60 * 60 * 1000), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
      });

      await checkSweepStaleness(true);
      await checkSweepStaleness(true);

      const adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_stalled",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).toBeNull();
      expect(adminNotifs[0]!.linkUrl).toBe("/admin");

      const regularNotifs = (await getNotifications(regular.tenantId)).filter(
        (n) => n.type === "sweep_stalled",
      );
      expect(regularNotifs).toHaveLength(0);
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });

  it("does not alert when the last run is fresh", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      await recordSweepRun(new Date(), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
      });

      await checkSweepStaleness(true);

      const notifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_stalled",
      );
      expect(notifs).toHaveLength(0);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("a completed sweep run resolves the stalled alert and re-arms the dedupe", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      await recordSweepRun(new Date(Date.now() - 60 * 60 * 1000), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
      });
      await checkSweepStaleness(true);

      // The sweep recovers: recording a fresh run marks the alert read.
      await recordSweepRun(new Date(), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
      });
      const afterRecovery = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_stalled",
      );
      expect(afterRecovery).toHaveLength(1);
      expect(afterRecovery[0]!.readAt).not.toBeNull();

      // A future stall produces a fresh alert (dedupe re-armed).
      await recordSweepRun(new Date(Date.now() - 60 * 60 * 1000), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
      });
      await checkSweepStaleness(true);
      const afterSecondStall = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_stalled",
      );
      expect(afterSecondStall).toHaveLength(2);
      expect(afterSecondStall.filter((n) => n.readAt === null)).toHaveLength(1);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("recordSweepRun", () => {
  it("upserts the single sweep_status row (id=1) and never grows the table", async () => {
    const { db, sweepStatusTable } = await import("@workspace/db");

    const firstRun = new Date("2026-07-15T10:00:00Z");
    await recordSweepRun(firstRun, 1200, {
      accountsChecked: 3,
      errorCount: 0,
      lastError: null,
    });

    const secondRun = new Date("2026-07-15T10:15:00Z");
    await recordSweepRun(secondRun, 800, {
      accountsChecked: 4,
      errorCount: 1,
      lastError: "boom",
    });

    const rows = await db.select().from(sweepStatusTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.lastRunAt.toISOString()).toBe(secondRun.toISOString());
    expect(rows[0]!.durationMs).toBe(800);
    expect(rows[0]!.accountsChecked).toBe(4);
    expect(rows[0]!.errorCount).toBe(1);
    expect(rows[0]!.lastError).toBe("boom");
  });
});

describe("triggerSweepNow", () => {
  it("returns immediately, runs in the background, and respects the overlap guard", async () => {
    // First trigger starts a background sweep synchronously.
    const first = triggerSweepNow();
    expect(first).toBe(true);
    expect(isSweepRunning()).toBe(true);

    // A second trigger while the sweep is in flight is rejected by the
    // overlap guard without starting another run.
    expect(triggerSweepNow()).toBe(false);

    // Wait for the background sweep to finish.
    await vi.waitFor(() => {
      expect(isSweepRunning()).toBe(false);
    });

    // Once the in-flight sweep finished, a new trigger runs again.
    expect(triggerSweepNow()).toBe(true);
    await vi.waitFor(() => {
      expect(isSweepRunning()).toBe(false);
    });
  });
});
