import {
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import express from "express";

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

import {
  pool,
  db,
  analyticsEventsTable,
  userConsentsTable,
  tenantMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import analyticsIngestRouter from "./analyticsIngest";
import analyticsRouter from "./analytics";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

function buildApp() {
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
  // Mirrors routes/index.ts ordering: ingest is PUBLIC, reports are gated.
  app.use("/api", analyticsIngestRouter);
  app.use("/api", requireTenant, analyticsRouter);
  return app;
}

const app = buildApp();

async function setConsent(
  clerkUserId: string,
  flags: Partial<{
    analytics: boolean;
    deviceDetails: boolean;
    locationCoarse: boolean;
    locationPrecise: boolean;
    carrier: boolean;
  }>,
) {
  await db.insert(userConsentsTable).values({
    clerkUserId,
    analytics: flags.analytics ?? false,
    deviceDetails: flags.deviceDetails ?? false,
    locationCoarse: flags.locationCoarse ?? false,
    locationPrecise: flags.locationPrecise ?? false,
    carrier: flags.carrier ?? false,
    respondedAt: new Date(),
  });
}

async function eventsForUser(clerkUserId: string) {
  return db
    .select()
    .from(analyticsEventsTable)
    .where(eq(analyticsEventsTable.clerkUserId, clerkUserId));
}

async function cleanupUser(clerkUserId: string) {
  await db
    .delete(analyticsEventsTable)
    .where(eq(analyticsEventsTable.clerkUserId, clerkUserId));
  await db
    .delete(userConsentsTable)
    .where(eq(userConsentsTable.clerkUserId, clerkUserId));
}

async function cleanupAnon(anonymousId: string) {
  await db
    .delete(analyticsEventsTable)
    .where(eq(analyticsEventsTable.anonymousId, anonymousId));
}

const FULL_CONTEXT = {
  platform: "web",
  appVersion: "1.0",
  osVersion: "macOS",
  browser: "Chrome 126",
  deviceModel: "MacBook",
  networkType: "4g",
  carrier: "TestCarrier",
  language: "en",
  latitude: 12.9,
  longitude: 77.6,
};

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  await pool.end();
});

describe("POST /analytics/events (ingestion consent enforcement)", () => {
  it("anonymous: accepts only lifecycle events and strips gated context", async () => {
    const anonId = `anon_${Date.now()}_a`;
    try {
      const res = await request(app)
        .post("/api/analytics/events")
        .send({
          anonymousId: anonId,
          sessionId: "s1",
          context: FULL_CONTEXT,
          events: [
            { name: "page_view", params: { page: "/landing" } },
            { name: "caption_generated" }, // not anonymous-allowed
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: 1, dropped: 1 });

      const rows = await db
        .select()
        .from(analyticsEventsTable)
        .where(eq(analyticsEventsTable.anonymousId, anonId));
      expect(rows.length).toBe(1);
      expect(rows[0].eventName).toBe("page_view");
      // Consent-gated fields must be nulled for anonymous senders.
      expect(rows[0].osVersion).toBeNull();
      expect(rows[0].deviceModel).toBeNull();
      expect(rows[0].carrier).toBeNull();
      expect(rows[0].latitude).toBeNull();
      expect(rows[0].country).toBeNull();
    } finally {
      await cleanupAnon(anonId);
    }
  });

  it("signed-in without analytics consent: whole batch dropped", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      const res = await request(app)
        .post("/api/analytics/events")
        .send({ events: [{ name: "page_view" }, { name: "caption_generated" }] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: 0, dropped: 2 });
      expect((await eventsForUser(tenant.clerkUserId)).length).toBe(0);
    } finally {
      await cleanupUser(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("stored category opt-outs null gated fields even when the client sends them", async () => {
    const tenant = await createTenant();
    try {
      await setConsent(tenant.clerkUserId, {
        analytics: true,
        deviceDetails: false,
        carrier: false,
        locationPrecise: false,
      });
      actAs(tenant.clerkUserId, "u@example.com");
      const res = await request(app)
        .post("/api/analytics/events")
        .send({
          context: FULL_CONTEXT,
          events: [{ name: "caption_generated", params: { platform: "instagram" } }],
        });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      const rows = await eventsForUser(tenant.clerkUserId);
      expect(rows.length).toBe(1);
      expect(rows[0].eventName).toBe("caption_generated");
      expect(rows[0].osVersion).toBeNull();
      expect(rows[0].deviceModel).toBeNull();
      expect(rows[0].carrier).toBeNull();
      expect(rows[0].latitude).toBeNull();
      // Ungated context is kept.
      expect(rows[0].platform).toBe("web");
      expect(rows[0].appVersion).toBe("1.0");
    } finally {
      await cleanupUser(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("full consent keeps gated fields", async () => {
    const tenant = await createTenant();
    try {
      await setConsent(tenant.clerkUserId, {
        analytics: true,
        deviceDetails: true,
        carrier: true,
        locationPrecise: true,
      });
      actAs(tenant.clerkUserId, "u@example.com");
      const res = await request(app)
        .post("/api/analytics/events")
        .send({ context: FULL_CONTEXT, events: [{ name: "image_generated" }] });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      const rows = await eventsForUser(tenant.clerkUserId);
      expect(rows[0].osVersion).toBe("macOS");
      expect(rows[0].deviceModel).toBe("MacBook");
      expect(rows[0].carrier).toBe("TestCarrier");
      expect(Number(rows[0].latitude)).toBeCloseTo(12.9);
    } finally {
      await cleanupUser(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("dedupes first_open per anonymous id across retried batches", async () => {
    const anonId = `anon_${Date.now()}_fo`;
    try {
      // First launch: first_open lands server-side (but suppose the
      // response was lost, so the client retries later).
      const first = await request(app)
        .post("/api/analytics/events")
        .send({
          anonymousId: anonId,
          events: [{ name: "first_open" }],
        });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ accepted: 1, dropped: 0 });

      // Retry on a later launch: the duplicate first_open must be dropped,
      // but other events in the same batch are still accepted.
      const retry = await request(app)
        .post("/api/analytics/events")
        .send({
          anonymousId: anonId,
          events: [{ name: "first_open" }, { name: "session_start" }],
        });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ accepted: 1, dropped: 1 });

      const rows = await db
        .select()
        .from(analyticsEventsTable)
        .where(eq(analyticsEventsTable.anonymousId, anonId));
      const firstOpens = rows.filter((r) => r.eventName === "first_open");
      expect(firstOpens.length).toBe(1);
      expect(rows.some((r) => r.eventName === "session_start")).toBe(true);
    } finally {
      await cleanupAnon(anonId);
    }
  });

  it("dedupes duplicate first_open events within a single batch", async () => {
    const anonId = `anon_${Date.now()}_fo2`;
    try {
      const res = await request(app)
        .post("/api/analytics/events")
        .send({
          anonymousId: anonId,
          events: [{ name: "first_open" }, { name: "first_open" }],
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: 1, dropped: 1 });

      const rows = await db
        .select()
        .from(analyticsEventsTable)
        .where(eq(analyticsEventsTable.anonymousId, anonId));
      expect(rows.length).toBe(1);
    } finally {
      await cleanupAnon(anonId);
    }
  });

  it("merges earlier anonymous events into the user identity at login", async () => {
    const anonId = `anon_${Date.now()}_m`;
    const tenant = await createTenant();
    try {
      // 1. Anonymous page view.
      await request(app)
        .post("/api/analytics/events")
        .send({ anonymousId: anonId, events: [{ name: "page_view" }] });
      // 2. Same browser signs in and sends another batch with the anon id.
      await setConsent(tenant.clerkUserId, { analytics: true });
      actAs(tenant.clerkUserId, "u@example.com");
      await request(app)
        .post("/api/analytics/events")
        .send({ anonymousId: anonId, events: [{ name: "content_saved" }] });

      const rows = await eventsForUser(tenant.clerkUserId);
      const names = rows.map((r) => r.eventName).sort();
      expect(names).toEqual(["content_saved", "page_view"]);
    } finally {
      await cleanupAnon(anonId);
      await cleanupUser(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("GET /analytics/funnels (activation funnel)", () => {
  it("counts the connected-account step and reports time to first publish", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const tenant = await createTenant();
    try {
      await setConsent(tenant.clerkUserId, { analytics: true });
      actAs(tenant.clerkUserId, "funnel-user@example.com");
      // sign_up → account_connected → post_published, 60s apart, so the
      // funnel gets one user in each step and a measurable publish time.
      const base = Date.now() - 10 * 60 * 1000;
      for (const [i, name] of ["sign_up", "account_connected", "post_published"].entries()) {
        await request(app)
          .post("/api/analytics/events")
          .send({ events: [{ name, clientTimestamp: new Date(base + i * 60_000).toISOString() }] });
      }
      // clientTimestamp only affects the client column; createdAt (used by the
      // funnel math) is insert time, so the avg is near-zero but present.
      actAs(admin.clerkUserId, "super@example.com");
      const res = await request(app).get("/api/analytics/funnels");
      expect(res.status).toBe(200);
      const steps = res.body.funnel.map((s: { step: string }) => s.step);
      // Connecting an account is an independent adoption stat, not a funnel step.
      expect(steps).not.toContain("Connected an account");
      expect(res.body.accountsConnected).toBeGreaterThanOrEqual(1);
      expect(typeof res.body.avgTimeToFirstPublishSec).toBe("number");
      expect(res.body.avgTimeToFirstPublishSec).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanupUser(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
      await deleteTenant(admin.tenantId);
    }
  });

  it("reports first-post nudge effectiveness (shown → clicked → published, dismiss rate)", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const tenant = await createTenant();
    try {
      await setConsent(tenant.clerkUserId, { analytics: true });
      actAs(tenant.clerkUserId, "nudge-user@example.com");
      // Shown → step clicked → published (in insert order, so the publish is
      // after the first shown event), plus a dismissal.
      for (const name of [
        "first_post_nudge_shown",
        "first_post_nudge_step_clicked",
        "post_published",
        "first_post_nudge_dismissed",
      ]) {
        await request(app)
          .post("/api/analytics/events")
          .send({ events: [{ name }] });
      }
      actAs(admin.clerkUserId, "super@example.com");
      const res = await request(app).get("/api/analytics/funnels");
      expect(res.status).toBe(200);
      const nudge = res.body.firstPostNudge;
      expect(nudge.shown).toBeGreaterThanOrEqual(1);
      expect(nudge.clicked).toBeGreaterThanOrEqual(1);
      expect(nudge.dismissed).toBeGreaterThanOrEqual(1);
      expect(nudge.publishedAfterShown).toBeGreaterThanOrEqual(1);
      // Rates are shares of shown users, so they stay within [0, 1].
      for (const rate of [nudge.clickRate, nudge.dismissRate, nudge.conversionRate]) {
        expect(rate).toBeGreaterThan(0);
        expect(rate).toBeLessThanOrEqual(1);
      }
    } finally {
      await cleanupUser(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
      await deleteTenant(admin.tenantId);
    }
  });

  it("ignores clicks/dismissals from users without an in-window shown event (rates never exceed 1)", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const userId = `test_nudge_noshown_${Date.now()}`;
    try {
      // Click + dismiss + publish, but NO shown event in the window: none of
      // these may count, and rates must stay 0 with a 0 cohort.
      await db.insert(analyticsEventsTable).values(
        ["first_post_nudge_step_clicked", "first_post_nudge_dismissed", "post_published"].map(
          (eventName, i) => ({
            clerkUserId: userId,
            eventName,
            createdAt: new Date(Date.now() - (3 - i) * 60_000),
          }),
        ),
      );
      actAs(admin.clerkUserId, "super@example.com");
      // Narrow window that contains only this user's events to isolate the run.
      const from = new Date(Date.now() - 5 * 60_000).toISOString();
      const res = await request(app).get(`/api/analytics/funnels?from=${from}`);
      expect(res.status).toBe(200);
      const nudge = res.body.firstPostNudge;
      expect(nudge.clicked).toBeLessThanOrEqual(nudge.shown);
      expect(nudge.dismissed).toBeLessThanOrEqual(nudge.shown);
      expect(nudge.publishedAfterShown).toBeLessThanOrEqual(nudge.shown);
      for (const rate of [nudge.clickRate, nudge.dismissRate, nudge.conversionRate]) {
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(1);
      }
    } finally {
      await cleanupUser(userId);
      await deleteTenant(admin.tenantId);
    }
  });

  it("tenant drilldown excludes publishes that happened in another tenant", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const userId = `test_nudge_xt_${Date.now()}`;
    try {
      // Same user: saw the nudge in tenant A, but the later publish landed in
      // tenant B. The tenant-A drilldown must NOT count it as a conversion.
      await db.insert(analyticsEventsTable).values([
        {
          tenantId: tenantA.tenantId,
          clerkUserId: userId,
          eventName: "first_post_nudge_shown",
          createdAt: new Date(Date.now() - 2 * 60_000),
        },
        {
          tenantId: tenantB.tenantId,
          clerkUserId: userId,
          eventName: "post_published",
          createdAt: new Date(Date.now() - 60_000),
        },
      ]);
      actAs(admin.clerkUserId, "super@example.com");
      const scoped = await request(app).get(
        `/api/analytics/funnels?tenantId=${tenantA.tenantId}`,
      );
      expect(scoped.status).toBe(200);
      expect(scoped.body.firstPostNudge.shown).toBe(1);
      expect(scoped.body.firstPostNudge.publishedAfterShown).toBe(0);
      // Platform-wide (no drilldown) still counts the cross-tenant publish.
      const platform = await request(app).get("/api/analytics/funnels");
      expect(platform.status).toBe(200);
      expect(platform.body.firstPostNudge.publishedAfterShown).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupUser(userId);
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("GET /analytics/* (access gating)", () => {
  it("superadmin can read platform analytics", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    try {
      actAs(tenant.clerkUserId, "super@example.com");
      const res = await request(app).get("/api/analytics/audience");
      expect(res.status).toBe(200);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("workspace owners get 403", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "owner@example.com");
      const res = await request(app).get("/api/analytics/audience");
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("plain team members get 403", async () => {
    const owner = await createTenant();
    const memberClerkId = `test_member_${Date.now()}`;
    try {
      await db.insert(tenantMembersTable).values({
        tenantId: owner.tenantId,
        clerkUserId: memberClerkId,
        role: "member",
      });
      actAs(memberClerkId, "member@example.com");
      const res = await request(app).get("/api/analytics/audience");
      expect(res.status).toBe(403);
    } finally {
      await db
        .delete(tenantMembersTable)
        .where(eq(tenantMembersTable.clerkUserId, memberClerkId));
      await deleteTenant(owner.tenantId);
    }
  });

  it("admin team members get 403", async () => {
    const owner = await createTenant();
    const adminClerkId = `test_admin_${Date.now()}`;
    try {
      await db.insert(tenantMembersTable).values({
        tenantId: owner.tenantId,
        clerkUserId: adminClerkId,
        role: "admin",
      });
      actAs(adminClerkId, "admin@example.com");
      const res = await request(app).get("/api/analytics/audience");
      expect(res.status).toBe(403);
    } finally {
      await db
        .delete(tenantMembersTable)
        .where(eq(tenantMembersTable.clerkUserId, adminClerkId));
      await deleteTenant(owner.tenantId);
    }
  });
});
