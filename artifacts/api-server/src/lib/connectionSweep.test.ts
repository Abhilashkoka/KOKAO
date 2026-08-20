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

// Sweeps walk the whole shared dev DB; under a full parallel monorepo test
// run the DB is heavily loaded and individual sweep tests can exceed the 30s
// default. Load-related slowness is not a failure.
vi.setConfig({ testTimeout: 120_000 });

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

// The sweep also covers ad-account connections. Leftover rows from other
// test files in the shared dev DB would otherwise hit the real Meta Ads API
// (timing out per row and eventually timing out whole tests), so stub the
// ads reverifier — this file only asserts on social behavior.
vi.mock("./adsReverify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adsReverify")>();
  return {
    ...actual,
    reverifyAdConnection: vi.fn(async () => ({
      checked: false as const,
      verifyStatus: null,
    })),
  };
});

import { pool } from "@workspace/db";
import { testFacebookCredentials } from "./metaApi";
import {
  sweepDeadConnections,
  recordSweepRun,
  triggerSweepNow,
  isSweepRunning,
  checkSweepStaleness,
  processFailStreakAlerts,
  SWEEP_FAIL_STREAK_ALERT_THRESHOLD,
  capFailStreaks,
  SWEEP_FAIL_STREAKS_CAP,
} from "./connectionSweep";
import type { SweepStreak } from "@workspace/db";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import {
  createTenant,
  deleteTenant,
  setNotificationPreference,
  insertConnectedAccount,
  insertLinkedinAccount,
  insertThreadsAccount,
  getConnectedAccount,
  getNotifications,
  setAccountState,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
  acquireSweepTestLock,
  releaseSweepTestLock,
} from "../test/dbHelpers";

const mockFb = vi.mocked(testFacebookCredentials);

/** More than REVERIFY_STALE_MS (15 min) in the past. */
function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

beforeAll(async () => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
  // Serialize with the other sweep-running suites: a parallel worker's sweep
  // would re-verify rows this suite seeds as dead (see dbHelpers).
  await acquireSweepTestLock();
}, 600_000);

afterAll(async () => {
  await releaseSweepTestLock();
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

  it("tracks a consecutive-failure streak across runs and resets it on success", async () => {
    const tenant = await createTenant();
    const key = `${tenant.tenantId}:facebook`;
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_S", pageAccessToken: "tok_s" },
        "verified",
      );

      // Run 1: the check crashes -> streak starts at 1.
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      mockFb.mockRejectedValue(new Error("provider timeout"));
      const first = await sweepDeadConnections();
      expect(first.failStreaks[key]).toMatchObject({
        count: 1,
        lastError: "provider timeout",
      });
      const firstFailedAt = first.failStreaks[key]!.firstFailedAt;
      expect(
        first.recentFailures.find(
          (f) => f.tenantId === tenant.tenantId && f.platform === "facebook",
        )?.consecutiveFailures,
      ).toBe(1);
      // Persist so the next run can continue the streak.
      await recordSweepRun(new Date(), 100, first);

      // Run 2: still failing -> streak continues at 2, firstFailedAt kept.
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      const second = await sweepDeadConnections();
      expect(second.failStreaks[key]).toMatchObject({
        count: 2,
        firstFailedAt,
      });
      expect(
        second.recentFailures.find(
          (f) => f.tenantId === tenant.tenantId && f.platform === "facebook",
        )?.consecutiveFailures,
      ).toBe(2);
      await recordSweepRun(new Date(), 100, second);

      // Run 3: the check recovers -> the streak key is gone.
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      mockFb.mockResolvedValue({ ok: true, accountName: "Test Page" });
      const third = await sweepDeadConnections();
      expect(third.failStreaks[key]).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps a long-streak chronic offender visible when more than the cap fail in one run", async () => {
    const { SWEEP_RECENT_FAILURES_CAP } = await import("./connectionSweep");
    const chronic = await createTenant();
    const fresh: Awaited<ReturnType<typeof createTenant>>[] = [];
    try {
      // Seed a prior 7-sweep streak for the chronic tenant so this run's
      // failure becomes its 8th consecutive failure.
      await insertConnectedAccount(
        chronic.tenantId,
        "facebook",
        { pageId: "PAGE_CHRONIC", pageAccessToken: "tok_c" },
        "failed",
      );
      await setAccountState(chronic.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      await recordSweepRun(new Date(), 100, {
        accountsChecked: 1,
        errorCount: 1,
        lastError: "seeded",
        recentFailures: [],
        failStreaks: {
          [`${chronic.tenantId}:facebook`]: {
            count: 7,
            firstFailedAt: new Date(
              Date.now() - 2 * 60 * 60 * 1000,
            ).toISOString(),
            lastError: "seeded",
            lastAt: new Date().toISOString(),
          },
        },
        droppedStreaks: 0,
      });

      // More one-off failures than the cap, all failing for the first time.
      for (let i = 0; i < SWEEP_RECENT_FAILURES_CAP + 2; i++) {
        const t = await createTenant();
        fresh.push(t);
        await insertConnectedAccount(
          t.tenantId,
          "facebook",
          { pageId: `PAGE_F${i}`, pageAccessToken: `tok_f${i}` },
          "failed",
        );
        await setAccountState(t.tenantId, "facebook", {
          verifiedAt: staleDate(),
        });
      }

      mockFb.mockRejectedValue(new Error("provider down"));
      const outcome = await sweepDeadConnections();

      expect(outcome.recentFailures.length).toBeLessThanOrEqual(
        SWEEP_RECENT_FAILURES_CAP,
      );
      // The chronic 8-streak offender must survive the trim despite the
      // flood of fresh one-off failures.
      const survivor = outcome.recentFailures.find(
        (f) => f.tenantId === chronic.tenantId && f.platform === "facebook",
      );
      expect(survivor).toBeDefined();
      expect(survivor!.consecutiveFailures).toBe(8);
    } finally {
      await deleteTenant(chronic.tenantId);
      for (const t of fresh) await deleteTenant(t.tenantId);
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
      // Count only this test's connections: other suites running in parallel
      // may seed stale facebook rows in the shared dev DB that the sweep
      // also checks, so an exact global call count is inherently flaky.
      const ownCalls = mockFb.mock.calls.filter(
        ([creds]) => creds.pageId === "PAGE_A" || creds.pageId === "PAGE_B",
      );
      expect(ownCalls).toHaveLength(2);

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

  it("surfaces a failed tenant breakage-notice write in the sweep outcome instead of a clean success", async () => {
    const { db, notificationsTable } = await import("@workspace/db");
    const { takeFailedSocialConnectionNoticeCount } = await import(
      "./notifications"
    );
    // Drain any residue from earlier tests so this test's tally is its own.
    takeFailedSocialConnectionNoticeCount();

    const tenant = await createTenant();
    // Simulate schema drift / DB errors on the notification write path only:
    // any insert targeting notificationsTable throws, everything else (the
    // account-status update path uses db.update) stays real.
    const realInsert = db.insert.bind(db);
    const insertSpy = vi
      .spyOn(db, "insert")
      .mockImplementation(((table: unknown) => {
        if (table === notificationsTable) {
          throw new Error('column "push" does not exist');
        }
        return realInsert(table as never);
      }) as typeof db.insert);
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_N", pageAccessToken: "tok_n" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      // Definitive rejection: verified -> failed transition fires the notice.
      mockFb.mockResolvedValue({ ok: false, error: "token revoked" });

      const outcome = await sweepDeadConnections();

      // The breakage was persisted (so the dedupe means the notice will
      // never re-fire)...
      const row = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(row?.verifyStatus).toBe("failed");
      // ...and the tenant notice never landed...
      const notifs = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "social_connection_failed",
      );
      expect(notifs).toHaveLength(0);
      // ...so the run must NOT look like a clean success: the lost notice is
      // counted and named, exactly like a failed superadmin alert delivery.
      expect(outcome.errorCount).toBeGreaterThanOrEqual(1);
      expect(outcome.lastError).toContain("tenant connection-failure notice");

      // The tally is drained by the sweep — a second run with nothing broken
      // does not re-report the same loss.
      expect(takeFailedSocialConnectionNoticeCount()).toBe(0);
    } finally {
      insertSpy.mockRestore();
      takeFailedSocialConnectionNoticeCount();
      await deleteTenant(tenant.tenantId);
    }
  });

  it("surfaces a failed ADS breakage-notice write in the sweep outcome instead of a clean success", async () => {
    const { db, notificationsTable } = await import("@workspace/db");
    const { notifyAdsConnectionFailed, takeFailedSocialConnectionNoticeCount } =
      await import("./notifications");
    // Drain any residue from earlier tests so this test's tally is its own.
    takeFailedSocialConnectionNoticeCount();

    const tenant = await createTenant();
    // Simulate schema drift / DB errors on the notification write path only:
    // any insert targeting notificationsTable throws, everything else stays
    // real (the dedupe SELECT and settings lookups use db.select).
    const realInsert = db.insert.bind(db);
    const insertSpy = vi
      .spyOn(db, "insert")
      .mockImplementation(((table: unknown) => {
        if (table === notificationsTable) {
          throw new Error('column "push" does not exist');
        }
        return realInsert(table as never);
      }) as typeof db.insert);
    try {
      // The connected -> failed transition in the ads reverifier fires this
      // exactly once; a swallowed insert means the owner never learns their
      // ad account grant died until an approved change fails.
      await notifyAdsConnectionFailed(tenant.tenantId, "meta", "token revoked");

      // The tenant notice never landed...
      const notifs = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === "ads_connection_failed",
      );
      expect(notifs).toHaveLength(0);

      // ...so the next sweep run must NOT look like a clean success: the
      // lost ads notice drains through the same counter as social notices.
      const outcome = await sweepDeadConnections();
      expect(outcome.errorCount).toBeGreaterThanOrEqual(1);
      expect(outcome.lastError).toContain("tenant connection-failure notice");

      // The tally is drained by the sweep — the same loss is not re-reported.
      expect(takeFailedSocialConnectionNoticeCount()).toBe(0);
    } finally {
      insertSpy.mockRestore();
      takeFailedSocialConnectionNoticeCount();
      await deleteTenant(tenant.tenantId);
    }
  });
});

// Retried: these tests assert on shared-DB sweep notifications that any
// concurrently running suite's real sweep can create/resolve mid-scenario.
describe("checkSweepStaleness", { retry: 2 }, () => {
  it("alerts a superadmin tenant once (deduped) when the last run is stale, and not a regular tenant", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      // Seed a last run well past the 35-minute threshold.
      await recordSweepRun(new Date(Date.now() - 60 * 60 * 1000), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
        recentFailures: [],
        failStreaks: {},
        droppedStreaks: 0,
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

  it("an admin who turned off the email channel keeps the in-app banner but gets no email", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const adminEmail = `sweep-optout-${admin.tenantId}@example.com`;
    try {
      await setNotificationPreference(admin.tenantId, "sweep_stalled", {
        inApp: true,
        email: false,
      });
      vi.mocked(fetchVerifiedEmail).mockImplementation(async (clerkUserId) =>
        clerkUserId === admin.clerkUserId ? adminEmail : null,
      );

      await recordSweepRun(new Date(Date.now() - 60 * 60 * 1000), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
        recentFailures: [],
        failStreaks: {},
        droppedStreaks: 0,
      });
      await checkSweepStaleness(true);

      const notifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_stalled",
      );
      expect(notifs).toHaveLength(1);
      expect(notifs[0]!.inApp).toBe(true);

      // No email went to the opted-out admin (other admins in the shared dev
      // DB may still be emailed, so assert on the recipient, not call count).
      const sentTo = vi
        .mocked(sendEmail)
        .mock.calls.map((c) => (c[0] as { to: string }).to);
      expect(sentTo).not.toContain(adminEmail);
    } finally {
      vi.mocked(fetchVerifiedEmail).mockResolvedValue(null);
      await deleteTenant(admin.tenantId);
    }
  });

  it("does not alert when the last run is fresh", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      await recordSweepRun(new Date(), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
        recentFailures: [],
        failStreaks: {},
        droppedStreaks: 0,
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
        recentFailures: [],
        failStreaks: {},
        droppedStreaks: 0,
      });
      await checkSweepStaleness(true);

      // The sweep recovers: recording a fresh run marks the alert read.
      await recordSweepRun(new Date(), 500, {
        accountsChecked: 0,
        errorCount: 0,
        lastError: null,
        recentFailures: [],
        failStreaks: {},
        droppedStreaks: 0,
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
        recentFailures: [],
        failStreaks: {},
        droppedStreaks: 0,
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

describe("capFailStreaks", () => {
  const streakAt = (count: number, lastAt: string): SweepStreak => ({
    count,
    firstFailedAt: "2026-07-17T09:00:00.000Z",
    lastError: "provider timeout",
    lastAt,
  });

  it("returns the same map untouched when within the cap", () => {
    const streaks = {
      "1:facebook": streakAt(3, "2026-07-18T10:00:00.000Z"),
      "2:linkedin": streakAt(1, "2026-07-18T10:01:00.000Z"),
    };
    const result = capFailStreaks(streaks);
    expect(result.streaks).toBe(streaks);
    expect(result.dropped).toBe(0);
  });

  it("keeps the longest streaks when over the cap, breaking ties by recency", () => {
    const streaks: Record<string, SweepStreak> = {};
    // Fill to exactly the cap with count=1 entries, oldest lastAt first.
    for (let i = 0; i < SWEEP_FAIL_STREAKS_CAP; i++) {
      streaks[`${i}:facebook`] = streakAt(
        1,
        new Date(Date.UTC(2026, 6, 18, 0, 0, i)).toISOString(),
      );
    }
    // Two extra entries: one chronic long streak (must survive) and one
    // one-off blip that is OLDER than everything else (must be dropped).
    streaks["9001:linkedin"] = streakAt(8, "2026-07-17T00:00:00.000Z");
    streaks["9002:threads"] = streakAt(1, "2026-07-16T00:00:00.000Z");

    const { streaks: capped, dropped } = capFailStreaks(streaks);
    expect(Object.keys(capped)).toHaveLength(SWEEP_FAIL_STREAKS_CAP);
    // Two entries over the cap were trimmed, and the count says so.
    expect(dropped).toBe(2);
    // The chronic streak survives despite being older than the blips.
    expect(capped["9001:linkedin"]).toEqual(streaks["9001:linkedin"]);
    // The two oldest count=1 entries are the ones trimmed.
    expect(capped["9002:threads"]).toBeUndefined();
    expect(capped["0:facebook"]).toBeUndefined();
    // Survivors keep their exact streak data.
    expect(capped["1:facebook"]).toEqual(streaks["1:facebook"]);
  });
});

// Retried: these tests assert on shared-DB sweep notifications that any
// concurrently running suite's real sweep can create/resolve mid-scenario.
describe("processFailStreakAlerts", { retry: 2 }, () => {
  const streak = (count: number, lastError = "provider timeout") => ({
    count,
    firstFailedAt: "2026-07-17T09:00:00.000Z",
    lastError,
    lastAt: new Date().toISOString(),
  });

  it("alerts a superadmin once a streak crosses the threshold, updates the unread banner in place while it continues, and not a regular tenant", async () => {
    // Interference note: any OTHER process sharing this dev DB (the running
    // api-server workflow's sweep, a parallel session's e2e run) that calls
    // processFailStreakAlerts resolves alerts whose keys it doesn't know —
    // including this test's — mid-scenario. A resolved alert makes the next
    // call re-create it (extra row + re-email), which looks exactly like a
    // dedupe regression. Detect that signature (a resolved row for our key
    // that this test never resolved) and retry the whole scenario on fresh
    // tenants; a real dedupe bug reproduces on every attempt.
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      const { fetchVerifiedEmail } = await import("./clerkUser");
      type Outcome = { interfered: boolean; run: () => void };
      const attempt = async (): Promise<Outcome> => {
        const offender = await createTenant();
        const key = `${offender.tenantId}:facebook`;
        try {
          // Below the threshold: no alert.
          await processFailStreakAlerts({
            [key]: streak(SWEEP_FAIL_STREAK_ALERT_THRESHOLD - 1),
          });
          const below = (await getNotifications(admin.tenantId)).filter(
            (n) => n.platform === `streak:${key}`,
          );

          // Crossing the threshold fires exactly one alert...
          await processFailStreakAlerts({
            [key]: streak(SWEEP_FAIL_STREAK_ALERT_THRESHOLD),
          });
          const crossed = (await getNotifications(admin.tenantId)).filter(
            (n) => n.platform === `streak:${key}`,
          );

          // ...and a continuing streak stays silent (no new row, no re-email)
          // but the unread banner is updated in place with the latest count.
          const emailLookupsBefore = vi.mocked(fetchVerifiedEmail).mock.calls
            .length;
          await processFailStreakAlerts({
            [key]: streak(SWEEP_FAIL_STREAK_ALERT_THRESHOLD + 5),
          });
          const emailLookupsAfter = vi.mocked(fetchVerifiedEmail).mock.calls
            .length;
          const continued = (await getNotifications(admin.tenantId)).filter(
            (n) => n.platform === `streak:${key}`,
          );
          const regularNotifs = (
            await getNotifications(regular.tenantId)
          ).filter((n) => n.platform === `streak:${key}`);

          // This test never resolves its alert, so any read row for our key
          // (or a duplicate row) is the external-resolve signature.
          const interfered =
            continued.some((n) => n.readAt !== null) || continued.length > 1;
          return {
            interfered,
            run: () => {
              expect(below).toHaveLength(0);
              expect(crossed).toHaveLength(1);
              expect(crossed[0]!.message).toContain(
                `failed ${SWEEP_FAIL_STREAK_ALERT_THRESHOLD} sweeps in a row`,
              );
              expect(emailLookupsAfter).toBe(emailLookupsBefore);
              expect(continued).toHaveLength(1);
              expect(continued[0]!.readAt).toBeNull();
              expect(continued[0]!.linkUrl).toBe("/admin");
              expect(continued[0]!.message).toContain("Facebook Page");
              expect(continued[0]!.message).toContain("provider timeout");
              expect(continued[0]!.message).toContain(
                `failed ${SWEEP_FAIL_STREAK_ALERT_THRESHOLD + 5} sweeps in a row`,
              );
              expect(regularNotifs).toHaveLength(0);
            },
          };
        } finally {
          await deleteTenant(offender.tenantId);
        }
      };

      let outcome = await attempt();
      for (let retry = 0; retry < 4 && outcome.interfered; retry++) {
        outcome = await attempt();
      }
      outcome.run();
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });

  it("an admin who turned off the email channel keeps the in-app banner but gets no email", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const offender = await createTenant();
    const adminEmail = `streak-optout-${admin.tenantId}@example.com`;
    try {
      await setNotificationPreference(admin.tenantId, "sweep_fail_streak", {
        inApp: true,
        email: false,
      });
      vi.mocked(fetchVerifiedEmail).mockImplementation(async (clerkUserId) =>
        clerkUserId === admin.clerkUserId ? adminEmail : null,
      );

      await processFailStreakAlerts({
        [`${offender.tenantId}:facebook`]: streak(
          SWEEP_FAIL_STREAK_ALERT_THRESHOLD,
        ),
      });

      const notifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_streak",
      );
      expect(notifs).toHaveLength(1);
      expect(notifs[0]!.inApp).toBe(true);

      const sentTo = vi
        .mocked(sendEmail)
        .mock.calls.map((c) => (c[0] as { to: string }).to);
      expect(sentTo).not.toContain(adminEmail);
    } finally {
      vi.mocked(fetchVerifiedEmail).mockResolvedValue(null);
      await deleteTenant(admin.tenantId);
      await deleteTenant(offender.tenantId);
    }
  });

  it("by default (no stored preference) a fresh alert still emails the admin", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const offender = await createTenant();
    const adminEmail = `streak-default-${admin.tenantId}@example.com`;
    try {
      vi.mocked(fetchVerifiedEmail).mockImplementation(async (clerkUserId) =>
        clerkUserId === admin.clerkUserId ? adminEmail : null,
      );

      await processFailStreakAlerts({
        [`${offender.tenantId}:facebook`]: streak(
          SWEEP_FAIL_STREAK_ALERT_THRESHOLD,
        ),
      });

      const sentTo = vi
        .mocked(sendEmail)
        .mock.calls.map((c) => (c[0] as { to: string }).to);
      expect(sentTo).toContain(adminEmail);
    } finally {
      vi.mocked(fetchVerifiedEmail).mockResolvedValue(null);
      await deleteTenant(admin.tenantId);
      await deleteTenant(offender.tenantId);
    }
  });

  it("a streak reset resolves the alert and re-arms the dedupe for a new streak", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const offender = await createTenant();
    const key = `${offender.tenantId}:linkedin`;
    try {
      await processFailStreakAlerts({
        [key]: streak(SWEEP_FAIL_STREAK_ALERT_THRESHOLD),
      });

      // The check recovers: the streak key disappears, the alert clears.
      await processFailStreakAlerts({});
      const afterRecovery = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_streak",
      );
      expect(afterRecovery).toHaveLength(1);
      expect(afterRecovery[0]!.readAt).not.toBeNull();

      // A NEW streak on the same tenant+platform alerts afresh.
      await processFailStreakAlerts({
        [key]: streak(SWEEP_FAIL_STREAK_ALERT_THRESHOLD),
      });
      const afterSecondStreak = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_streak",
      );
      expect(afterSecondStreak).toHaveLength(2);
      expect(
        afterSecondStreak.filter((n) => n.readAt === null),
      ).toHaveLength(1);
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(offender.tenantId);
    }
  });

  it("only clears the recovered streak's alert, keeping other active offenders unread", async () => {
    // Clearing is global: any concurrent suite that runs the real sweep calls
    // processFailStreakAlerts with a map that lacks THIS test's keys, which
    // resolves offender B's alert mid-scenario (tests share one dev DB). That
    // interference is indistinguishable from the bug this test guards against,
    // so retry the whole scenario on fresh tenants a few times — a genuine
    // regression fails every attempt, while a collision passing once is proof
    // the recovered/active split works.
    const admin = await createTenant({ isSuperadmin: true });
    try {
      const attempt = async (): Promise<{
        aCleared: boolean;
        bUnread: boolean;
      }> => {
        const offenderA = await createTenant();
        const offenderB = await createTenant();
        try {
          await processFailStreakAlerts({
            [`${offenderA.tenantId}:facebook`]: streak(
              SWEEP_FAIL_STREAK_ALERT_THRESHOLD,
            ),
            [`${offenderB.tenantId}:twitter`]: streak(
              SWEEP_FAIL_STREAK_ALERT_THRESHOLD,
            ),
          });

          // A recovers; B keeps failing.
          await processFailStreakAlerts({
            [`${offenderB.tenantId}:twitter`]: streak(
              SWEEP_FAIL_STREAK_ALERT_THRESHOLD + 1,
            ),
          });

          const notifs = (await getNotifications(admin.tenantId)).filter(
            (n) => n.type === "sweep_fail_streak",
          );
          const forA = notifs.find(
            (n) => n.platform === `streak:${offenderA.tenantId}:facebook`,
          );
          const forB = notifs.find(
            (n) => n.platform === `streak:${offenderB.tenantId}:twitter`,
          );
          return {
            aCleared: forA != null && forA.readAt !== null,
            bUnread: forB != null && forB.readAt === null,
          };
        } finally {
          await deleteTenant(offenderA.tenantId);
          await deleteTenant(offenderB.tenantId);
        }
      };

      let outcome = await attempt();
      for (let retry = 0; retry < 2 && !(outcome.aCleared && outcome.bUnread); retry++) {
        outcome = await attempt();
      }
      expect(outcome.aCleared).toBe(true);
      expect(outcome.bUnread).toBe(true);
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
      recentFailures: [],
      failStreaks: {},
      droppedStreaks: 0,
    });

    const secondRun = new Date("2026-07-15T10:15:00Z");
    await recordSweepRun(secondRun, 800, {
      accountsChecked: 4,
      errorCount: 1,
      lastError: "boom",
      recentFailures: [
        {
          tenantId: 42,
          platform: "facebook",
          error: "boom",
          at: "2026-07-15T10:14:00.000Z",
          consecutiveFailures: 3,
        },
      ],
      failStreaks: {
        "42:facebook": {
          count: 3,
          firstFailedAt: "2026-07-15T09:44:00.000Z",
          lastError: "boom",
          lastAt: "2026-07-15T10:14:00.000Z",
        },
      },
      droppedStreaks: 5,
    });

    const rows = await db.select().from(sweepStatusTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.lastRunAt.toISOString()).toBe(secondRun.toISOString());
    expect(rows[0]!.durationMs).toBe(800);
    expect(rows[0]!.accountsChecked).toBe(4);
    expect(rows[0]!.errorCount).toBe(1);
    expect(rows[0]!.lastError).toBe("boom");
    expect(rows[0]!.recentFailures).toEqual([
      {
        tenantId: 42,
        platform: "facebook",
        error: "boom",
        at: "2026-07-15T10:14:00.000Z",
        consecutiveFailures: 3,
      },
    ]);
    expect(rows[0]!.droppedStreaks).toBe(5);
    expect(rows[0]!.failStreaks).toEqual({
      "42:facebook": {
        count: 3,
        firstFailedAt: "2026-07-15T09:44:00.000Z",
        lastError: "boom",
        lastAt: "2026-07-15T10:14:00.000Z",
      },
    });
  });
});

// Retried: these tests assert on shared-DB sweep notifications that any
// concurrently running suite's real sweep can create/resolve mid-scenario.
describe("sweep history trimmed alerts", { retry: 2 }, () => {
  const runOutcome = (droppedStreaks: number) => ({
    accountsChecked: 1,
    errorCount: droppedStreaks > 0 ? 1 : 0,
    lastError: droppedStreaks > 0 ? "boom" : null,
    recentFailures: [],
    failStreaks: {},
    droppedStreaks,
  });

  it("alerts a superadmin when a run trims streaks, dedupes while trimming continues, and resolves on a clean run", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      // A run that trimmed history fires exactly one superadmin alert.
      await recordSweepRun(new Date(), 500, runOutcome(7));
      let adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_history_trimmed",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).toBeNull();
      expect(adminNotifs[0]!.linkUrl).toBe("/admin");
      expect(adminNotifs[0]!.message).toContain("7 failure");

      // Regular tenants never see this operational alert.
      const regularNotifs = (await getNotifications(regular.tenantId)).filter(
        (n) => n.type === "sweep_history_trimmed",
      );
      expect(regularNotifs).toHaveLength(0);

      // Trimming continues: no new row, no re-email; the unread banner is
      // refreshed in place with the latest dropped count.
      const emailLookupsBefore = vi.mocked(fetchVerifiedEmail).mock.calls
        .length;
      await recordSweepRun(new Date(), 500, runOutcome(12));
      expect(vi.mocked(fetchVerifiedEmail).mock.calls.length).toBe(
        emailLookupsBefore,
      );
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_history_trimmed",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).toBeNull();
      expect(adminNotifs[0]!.message).toContain("12 failure");

      // A clean run resolves the alert (marks it read)...
      await recordSweepRun(new Date(), 500, runOutcome(0));
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_history_trimmed",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).not.toBeNull();

      // ...and re-arms the dedupe: a later trim alerts afresh.
      await recordSweepRun(new Date(), 500, runOutcome(3));
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_history_trimmed",
      );
      expect(adminNotifs).toHaveLength(2);
      const unread = adminNotifs.filter((n) => n.readAt === null);
      expect(unread).toHaveLength(1);
      expect(unread[0]!.message).toContain("3 failure");
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });
});

// Retried: these tests assert on shared-DB sweep notifications that any
// concurrently running suite's real sweep can create/resolve mid-scenario.
describe("sweep failure-ratio alerts", { retry: 2 }, () => {
  const ratioOutcome = (accountsChecked: number, errorCount: number) => ({
    accountsChecked,
    errorCount,
    lastError: errorCount > 0 ? "boom" : null,
    recentFailures: [],
    failStreaks: {},
    droppedStreaks: 0,
  });

  it("alerts a superadmin above the threshold, dedupes while the outage continues, and resolves below it", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      // 50 of 60 checks failing (83%) is above the 50% threshold and past
      // the minimum sample size — one superadmin alert fires.
      await recordSweepRun(new Date(), 500, ratioOutcome(60, 50));
      let adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).toBeNull();
      expect(adminNotifs[0]!.linkUrl).toBe("/admin");
      expect(adminNotifs[0]!.message).toContain("50 of 60");
      expect(adminNotifs[0]!.message).toContain("83%");

      // Regular tenants never see this operational alert.
      const regularNotifs = (await getNotifications(regular.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(regularNotifs).toHaveLength(0);

      // Outage continues: no new row, no re-email; the unread banner is
      // refreshed in place with the latest counts.
      const emailLookupsBefore = vi.mocked(fetchVerifiedEmail).mock.calls
        .length;
      await recordSweepRun(new Date(), 500, ratioOutcome(60, 55));
      expect(vi.mocked(fetchVerifiedEmail).mock.calls.length).toBe(
        emailLookupsBefore,
      );
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).toBeNull();
      expect(adminNotifs[0]!.message).toContain("55 of 60");

      // A run with too small a sample carries no signal: it neither alerts
      // nor resolves — the unread banner stays.
      await recordSweepRun(new Date(), 500, ratioOutcome(3, 3));
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).toBeNull();

      // A run below the threshold resolves the alert (marks it read)...
      await recordSweepRun(new Date(), 500, ratioOutcome(60, 2));
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(adminNotifs).toHaveLength(1);
      expect(adminNotifs[0]!.readAt).not.toBeNull();

      // ...and re-arms the dedupe: a later mass outage alerts afresh.
      await recordSweepRun(new Date(), 500, ratioOutcome(20, 15));
      adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(adminNotifs).toHaveLength(2);
      const unread = adminNotifs.filter((n) => n.readAt === null);
      expect(unread).toHaveLength(1);
      expect(unread[0]!.message).toContain("15 of 20");
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });

  it("lists which connections are failing in the alert message", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const broken = await createTenant();
    try {
      const outcome = {
        ...ratioOutcome(20, 15),
        recentFailures: [
          {
            tenantId: broken.tenantId,
            platform: "facebook",
            error: "boom",
            at: new Date().toISOString(),
          },
          {
            tenantId: broken.tenantId,
            platform: "linkedin",
            error: "boom",
            at: new Date().toISOString(),
          },
          {
            tenantId: 999999999,
            platform: "facebook",
            error: "boom",
            at: new Date().toISOString(),
          },
        ],
      };
      await recordSweepRun(new Date(), 500, outcome);
      const adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio" && n.readAt === null,
      );
      expect(adminNotifs).toHaveLength(1);
      const message = adminNotifs[0]!.message;
      // Per-platform tally, most-affected first.
      expect(message).toContain("Failing platforms: facebook (2), linkedin (1)");
      // Affected workspaces are listed; unknown tenants fall back to the id.
      expect(message).toContain("Disconnected:");
      expect(message).toContain("linkedin");
      expect(message).toContain("workspace #999999999 — facebook");
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(broken.tenantId);
    }
  });

  it("surfaces a failed alert write in the persisted sweep outcome instead of reporting a clean success", async () => {
    const { db, notificationsTable, sweepStatusTable } = await import(
      "@workspace/db"
    );
    const admin = await createTenant({ isSuperadmin: true });
    // Simulate schema drift / DB errors on the notification write path only:
    // any insert targeting notificationsTable throws, everything else (the
    // sweep_status upsert) stays real.
    const realInsert = db.insert.bind(db);
    const insertSpy = vi
      .spyOn(db, "insert")
      .mockImplementation(((table: unknown) => {
        if (table === notificationsTable) {
          throw new Error('column "push" does not exist');
        }
        return realInsert(table as never);
      }) as typeof db.insert);
    try {
      await recordSweepRun(new Date(), 500, ratioOutcome(60, 50));

      // The alert never landed...
      const adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio" && n.readAt === null,
      );
      expect(adminNotifs).toHaveLength(0);

      // ...so the persisted run must NOT look like a clean success: the
      // failed delivery is counted on top of the run's own errors and the
      // lastError names the alert-delivery failure.
      const [status] = await db
        .select()
        .from(sweepStatusTable)
        .where((await import("drizzle-orm")).eq(sweepStatusTable.id, 1));
      expect(status).toBeDefined();
      expect(status!.errorCount).toBeGreaterThan(50);
      expect(status!.lastError).toContain("superadmin sweep alert");
    } finally {
      insertSpy.mockRestore();
      await deleteTenant(admin.tenantId);
    }
  });

  it("never alerts when a high ratio comes from too few checks", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      await recordSweepRun(new Date(), 500, ratioOutcome(3, 2));
      const adminNotifs = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === "sweep_fail_ratio",
      );
      expect(adminNotifs).toHaveLength(0);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("triggerSweepNow", () => {
  it("returns immediately, runs in the background, and respects the overlap guard", async () => {
    const waitForSweep = () =>
      vi.waitFor(
        () => {
          expect(isSweepRunning()).toBe(false);
        },
        { timeout: 30_000, interval: 50 },
      );

    // First trigger starts a background sweep synchronously.
    const first = triggerSweepNow();
    expect(first).toBe(true);
    expect(isSweepRunning()).toBe(true);

    // A second trigger while the sweep is in flight is rejected by the
    // overlap guard without starting another run.
    expect(triggerSweepNow()).toBe(false);

    // Wait for the background sweep to finish.
    await waitForSweep();

    // Once the in-flight sweep finished, a new trigger runs again.
    expect(triggerSweepNow()).toBe(true);
    await waitForSweep();
  });
});
