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
import request from "supertest";

/**
 * End-to-end confirmation that a HUNG platform call (the provider accepts the
 * connection but never responds) surfaces as a FAILED content item in the app
 * instead of hanging the request — for every synchronous publish route
 * (Facebook, LinkedIn, Threads, X) — and that the graceful-shutdown drain
 * still finishes well under its 10s cap with a hung publish in flight.
 *
 * The hang is simulated by a global.fetch mock that never resolves and only
 * settles when the caller's AbortSignal fires — exactly what a black-holed
 * platform endpoint looks like to `platformFetch`. The timeout is shrunk via
 * PLATFORM_FETCH_TIMEOUT_MS (read at module load, hence the hoisted env set)
 * so the suite stays fast while exercising the real abort path.
 */
vi.hoisted(() => {
  process.env.PLATFORM_FETCH_TIMEOUT_MS = "500";
});

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
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
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

// The Facebook publish route forces a live pre-publish re-verification via
// lib/metaApi; stub only those network test functions so the gate passes and
// the hang is exercised by the actual Graph publish call.
vi.mock("../lib/metaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metaApi")>();
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

import { pool, type AppCredential } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertLinkedinAccount,
  insertThreadsAccount,
  insertContentItem,
  getContentItem,
  setAccountState,
  snapshotTwitterRow,
  setVerifiedTwitterRow,
  restoreTwitterRow,
} from "../test/dbHelpers";
import { PLATFORM_FETCH_TIMEOUT_MS } from "../lib/platformFetch";
import {
  resetShutdownStateForTests,
  waitForPendingJobs,
} from "../lib/backgroundJobs";
import { createShutdownHandler, SHUTDOWN_DRAIN_TIMEOUT_MS } from "../lib/shutdown";

const app = createTestApp();

// Generous wall-clock bound for a whole publish request: several sequential
// platform calls may each hang for PLATFORM_FETCH_TIMEOUT_MS (pre-publish
// re-verify, dedupe probe, the publish itself) but the request must still
// finish far under the 10s shutdown drain cap.
const REQUEST_BOUND_MS = 5_000;

/**
 * A fetch that black-holes every request: it never resolves and only rejects
 * once the caller's AbortSignal fires (with the signal's reason, so
 * AbortSignal.timeout produces a real "TimeoutError"). Anything not passing a
 * signal would hang forever — which is the point: only platformFetch's
 * bounded timeout can get a request out of here.
 */
function installHangingFetch(): void {
  global.fetch = vi.fn(
    (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // hang forever
        const fail = () =>
          reject(
            signal.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      }),
  ) as unknown as typeof fetch;
}

let originalFetch: typeof fetch;
let twitterSnapshot: AppCredential | null = null;

beforeAll(async () => {
  expect(PLATFORM_FETCH_TIMEOUT_MS).toBe(500);
  twitterSnapshot = await snapshotTwitterRow();
});

afterAll(async () => {
  await restoreTwitterRow(twitterSnapshot);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  originalFetch = global.fetch;
  installHangingFetch();
});

afterEach(async () => {
  global.fetch = originalFetch;
  // Never leave a shutdown flag or tracked request behind for other tests.
  await waitForPendingJobs();
  resetShutdownStateForTests();
});

async function expectFailedWithTimeout(opts: {
  tenantId: number;
  itemId: number;
  path: string;
  rejectedLabel: RegExp;
}): Promise<void> {
  const started = Date.now();
  const res = await request(app).post(opts.path);
  const elapsed = Date.now() - started;

  // The request must finish on its own (bounded timeout), well under the
  // shutdown drain cap — not hang until supertest gives up.
  expect(elapsed).toBeLessThan(REQUEST_BOUND_MS);
  expect(elapsed).toBeLessThan(SHUTDOWN_DRAIN_TIMEOUT_MS);

  expect(res.status).toBe(502);
  expect(res.body.error).toMatch(opts.rejectedLabel);
  expect(res.body.error).toMatch(/timed out/i);

  // The failure is persisted so the Content Library shows the item as failed
  // with the timeout reason after the toast is gone.
  const item = await getContentItem(opts.itemId, opts.tenantId);
  expect(item?.status).toBe("failed");
  expect(item?.failureReason).toMatch(opts.rejectedLabel);
  expect(item?.failureReason).toMatch(/timed out/i);
  expect(item?.failureReason).toMatch(/did not respond/i);
}

describe("hung platform call surfaces as a failed post (bounded timeout)", () => {
  it("Facebook: a never-responding Graph API marks the item failed with the timeout reason", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok_page" },
        "verified",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hang test fb",
      });
      actAs(tenant.clerkUserId);

      await expectFailedWithTimeout({
        tenantId: tenant.tenantId,
        itemId,
        path: `/api/content/${itemId}/publish-facebook`,
        rejectedLabel: /Facebook rejected the post/,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("LinkedIn: a never-responding API marks the item failed with the timeout reason", async () => {
    const tenant = await createTenant();
    try {
      // No token expiry: the hung pre-publish re-verify is a transient error
      // and must not flip a verified connection, so the publish proceeds and
      // the hang is surfaced by the post creation call itself.
      await insertLinkedinAccount(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hang test li",
      });
      actAs(tenant.clerkUserId);

      await expectFailedWithTimeout({
        tenantId: tenant.tenantId,
        itemId,
        path: `/api/content/${itemId}/publish-linkedin`,
        rejectedLabel: /LinkedIn rejected the post/,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("Threads: a never-responding API marks the item failed with the timeout reason", async () => {
    const tenant = await createTenant();
    try {
      // tokenExpiresAt null → no refresh round-trip; the dedupe probe hangs
      // (best-effort, swallowed) and the container-create call surfaces it.
      await insertThreadsAccount(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hang test threads",
      });
      actAs(tenant.clerkUserId);

      await expectFailedWithTimeout({
        tenantId: tenant.tenantId,
        itemId,
        path: `/api/content/${itemId}/publish-threads`,
        rejectedLabel: /Threads rejected the post/,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("X: a never-responding API marks the item failed with the timeout reason", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "twitter",
        { accessToken: "x_tok", refreshToken: "x_refresh" },
        "verified",
        "@testhandle",
      );
      // No expiry → no refresh round-trip; providerUserId set so the dedupe
      // probe runs (hangs, is swallowed) before the tweet call surfaces it.
      await setAccountState(tenant.tenantId, "twitter", {
        providerUserId: "x_user_123",
        tokenExpiresAt: null,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hang test x",
      });
      actAs(tenant.clerkUserId);

      await expectFailedWithTimeout({
        tenantId: tenant.tenantId,
        itemId,
        path: `/api/content/${itemId}/publish-twitter`,
        rejectedLabel: /X rejected the post/,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("graceful shutdown with a hung publish in flight", () => {
  it("the drain finishes well under its cap because the hung call is bounded, and the failure is persisted", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok_page" },
        "verified",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hang during shutdown",
      });
      actAs(tenant.clerkUserId);

      // Kick off the publish and give it a moment to get INSIDE the hung
      // platform call (past the gate, registered in the shutdown drain).
      const inFlight = request(app)
        .post(`/api/content/${itemId}/publish-facebook`)
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 150));

      const exit = vi.fn();
      const shutdown = createShutdownHandler({
        server: { close: vi.fn() },
        exit,
        // Real default drain (waitForPendingJobs) and the REAL 10s cap: the
        // point is that the drain resolves on its own, long before the cap.
      });

      const started = Date.now();
      await shutdown("SIGTERM");
      const drainElapsed = Date.now() - started;

      expect(exit).toHaveBeenCalledWith(0);
      // Well under the 10s cap: the bounded platform timeout (500ms here,
      // 6s in production — both < 10s) released the tracked request.
      expect(drainElapsed).toBeLessThan(5_000);

      // The in-flight request still completed and persisted its outcome —
      // the item is terminally "failed", not stuck on an ambiguous status.
      const res = await inFlight;
      expect(res.status).toBe(502);
      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item?.status).toBe("failed");
      expect(item?.failureReason).toMatch(/timed out/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
