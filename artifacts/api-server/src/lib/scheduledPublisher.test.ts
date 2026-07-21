import { describe, it, expect, afterAll, vi, beforeEach } from "vitest";
import { db, scheduledPostsTable, contentItemsTable, notificationsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import type { PublishOutcome } from "./publishOutcome";

// Mock every platform core so no real platform code (or network) runs.
const facebookCore = vi.fn<(t: number, c: number) => Promise<PublishOutcome>>();
const instagramCore = vi.fn<(t: number, c: number) => Promise<PublishOutcome>>();
const linkedinCore = vi.fn<(t: number, c: number) => Promise<PublishOutcome>>();
const twitterCore = vi.fn<(t: number, c: number) => Promise<PublishOutcome>>();
const threadsCore = vi.fn<(t: number, c: number) => Promise<PublishOutcome>>();

vi.mock("../routes/meta", () => ({
  publishFacebookCore: (t: number, c: number) => facebookCore(t, c),
  publishInstagramCore: (t: number, c: number) => instagramCore(t, c),
}));
vi.mock("../routes/linkedin", () => ({
  publishLinkedinCore: (t: number, c: number) => linkedinCore(t, c),
}));
vi.mock("../routes/twitter", () => ({
  publishTwitterCore: (t: number, c: number) => twitterCore(t, c),
}));
vi.mock("../routes/threads", () => ({
  publishThreadsCore: (t: number, c: number) => threadsCore(t, c),
}));
// Keep email/Clerk out of the picture: notifications go in-app only.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));

import {
  runScheduledPublishTick,
  retryScheduledPostNow,
  SCHEDULE_INTERRUPTED_REASON,
  SCHEDULED_TRANSIENT_RETRY,
  outageExhaustedReason,
} from "./scheduledPublisher";
import { tryAcquireResendLock } from "./resendLock";

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  facebookCore.mockReset();
  instagramCore.mockReset();
  linkedinCore.mockReset();
  twitterCore.mockReset();
  threadsCore.mockReset();
});

async function insertItem(tenantId: number, title = "Scheduled post"): Promise<number> {
  const [row] = await db
    .insert(contentItemsTable)
    .values({ tenantId, title, caption: "hello", status: "scheduled" })
    .returning();
  return row.id;
}

async function insertSchedule(
  tenantId: number,
  contentItemId: number,
  platform: string,
  opts: { scheduledAt?: Date; status?: string; updatedAt?: Date } = {},
): Promise<number> {
  const [row] = await db
    .insert(scheduledPostsTable)
    .values({
      tenantId,
      contentItemId,
      platform,
      scheduledAt: opts.scheduledAt ?? new Date(Date.now() - 60_000),
      status: opts.status ?? "pending",
    })
    .returning();
  if (opts.updatedAt) {
    await db
      .update(scheduledPostsTable)
      .set({ updatedAt: opts.updatedAt })
      .where(eq(scheduledPostsTable.id, row.id));
  }
  return row.id;
}

async function getSchedule(id: number) {
  const rows = await db
    .select()
    .from(scheduledPostsTable)
    .where(eq(scheduledPostsTable.id, id));
  return rows[0];
}

async function getNotifications(tenantId: number, type: string) {
  return db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, type),
      ),
    );
}

describe("runScheduledPublishTick", () => {
  it("publishes a due pending schedule and records a success notification", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId, "Morning brew");
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "facebook");
      facebookCore.mockResolvedValue({ ok: true, postId: "fb_1", permalink: null });

      await runScheduledPublishTick();

      expect(facebookCore).toHaveBeenCalledWith(tenant.tenantId, itemId);
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("published");
      expect(schedule.failureReason).toBeNull();

      const notifs = await getNotifications(tenant.tenantId, "scheduled_post_published");
      expect(notifs.length).toBe(1);
      expect(notifs[0].message).toContain("Morning brew");
      expect(notifs[0].message).toContain("Facebook");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks a failed publish with the core's error and notifies", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId, "Evening post");
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter");
      twitterCore.mockResolvedValue({
        ok: false,
        errorStatus: 400,
        error: "Your X connection expired. Reconnect and try again.",
      });

      await runScheduledPublishTick();

      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toContain("connection expired");

      const notifs = await getNotifications(tenant.tenantId, "scheduled_publish_failed");
      expect(notifs.length).toBe(1);
      expect(notifs[0].message).toContain("Evening post");
      expect(notifs[0].message).toContain("connection expired");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("leaves future schedules alone", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "facebook", {
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      await runScheduledPublishTick();

      expect(facebookCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("pending");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("fails an unsupported platform with a clear reason instead of crashing", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "youtube");

      await runScheduledPublishTick();

      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toContain("not supported");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("defers (back to pending) when a manual publish holds the item lock", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "linkedin");
      const release = tryAcquireResendLock("linkedin", itemId);
      expect(release).not.toBeNull();
      try {
        await runScheduledPublishTick();
      } finally {
        release!();
      }

      expect(linkedinCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("pending");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("recovers schedules stuck in 'processing' from a crashed run", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "threads", {
        status: "processing",
        updatedAt: new Date(Date.now() - 30 * 60 * 1000),
      });

      await runScheduledPublishTick();

      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toBe(SCHEDULE_INTERRUPTED_REASON);
      const notifs = await getNotifications(tenant.tenantId, "scheduled_publish_failed");
      expect(notifs.length).toBe(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("leaves a recently-updated 'processing' schedule alone (may be live elsewhere)", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "threads", {
        status: "processing",
      });

      await runScheduledPublishTick();

      expect(threadsCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("processing");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("skips the final write and notification if the schedule was cancelled mid-publish", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "facebook");
      facebookCore.mockImplementation(async () => {
        // Simulate the user cancelling while the platform call is in flight.
        await db
          .update(scheduledPostsTable)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(scheduledPostsTable.id, scheduleId));
        return { ok: true, postId: "fb_race", permalink: null };
      });

      await runScheduledPublishTick();

      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("cancelled");
      const notifs = await getNotifications(tenant.tenantId, "scheduled_post_published");
      expect(notifs.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  describe("transient (503) auto-retry", () => {
    const TRANSIENT_ERROR = "X is temporarily unavailable. Please try again in a few minutes.";
    const transientOutcome: PublishOutcome = {
      ok: false,
      errorStatus: 503,
      error: TRANSIENT_ERROR,
    };

    it("re-queues a transient X failure as pending with a delay instead of failing", async () => {
      const tenant = await createTenant();
      try {
        const itemId = await insertItem(tenant.tenantId, "Flaky bird");
        const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter");
        twitterCore.mockResolvedValue(transientOutcome);

        await runScheduledPublishTick();

        const schedule = await getSchedule(scheduleId);
        expect(schedule.status).toBe("pending");
        expect(schedule.retryCount).toBe(1);
        expect(schedule.failureReason).toBe(TRANSIENT_ERROR);
        expect(schedule.scheduledAt.getTime()).toBeGreaterThan(Date.now());
        // No failure notification while retries remain.
        const notifs = await getNotifications(tenant.tenantId, "scheduled_publish_failed");
        expect(notifs.length).toBe(0);
      } finally {
        await deleteTenant(tenant.tenantId);
      }
    });

    it("retries then publishes once the outage clears", async () => {
      const tenant = await createTenant();
      const origDelay = SCHEDULED_TRANSIENT_RETRY.delayMs;
      SCHEDULED_TRANSIENT_RETRY.delayMs = 0;
      try {
        const itemId = await insertItem(tenant.tenantId, "Second try");
        const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter");
        twitterCore
          .mockResolvedValueOnce(transientOutcome)
          .mockResolvedValueOnce({ ok: true, postId: "tw_1", permalink: null });

        await runScheduledPublishTick();
        await runScheduledPublishTick();

        expect(twitterCore).toHaveBeenCalledTimes(2);
        const schedule = await getSchedule(scheduleId);
        expect(schedule.status).toBe("published");
        expect(schedule.failureReason).toBeNull();
        const success = await getNotifications(tenant.tenantId, "scheduled_post_published");
        expect(success.length).toBe(1);
        const failures = await getNotifications(tenant.tenantId, "scheduled_publish_failed");
        expect(failures.length).toBe(0);
      } finally {
        SCHEDULED_TRANSIENT_RETRY.delayMs = origDelay;
        await deleteTenant(tenant.tenantId);
      }
    });

    it("fails and notifies once the retry budget is exhausted", async () => {
      const tenant = await createTenant();
      const origDelay = SCHEDULED_TRANSIENT_RETRY.delayMs;
      const origMax = SCHEDULED_TRANSIENT_RETRY.maxRetries;
      SCHEDULED_TRANSIENT_RETRY.delayMs = 0;
      SCHEDULED_TRANSIENT_RETRY.maxRetries = 2;
      try {
        const itemId = await insertItem(tenant.tenantId, "Persistent outage");
        const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter");
        twitterCore.mockResolvedValue(transientOutcome);

        await runScheduledPublishTick(); // attempt 1 -> retry 1
        await runScheduledPublishTick(); // attempt 2 -> retry 2
        await runScheduledPublishTick(); // attempt 3 -> budget exhausted -> failed

        expect(twitterCore).toHaveBeenCalledTimes(3);
        const schedule = await getSchedule(scheduleId);
        expect(schedule.status).toBe("failed");
        expect(schedule.retryCount).toBe(2);
        // Exhausted budget wraps the last error in an outage explanation so
        // the failureReason and notification distinguish "the platform kept
        // being down" from a definitive rejection.
        expect(schedule.failureReason).toBe(outageExhaustedReason(3, TRANSIENT_ERROR));
        expect(schedule.failureReason).toContain("temporary problems");
        expect(schedule.failureReason).toContain(TRANSIENT_ERROR);
        const notifs = await getNotifications(tenant.tenantId, "scheduled_publish_failed");
        expect(notifs.length).toBe(1);
        expect(notifs[0].message).toContain("platform outage");
        expect(notifs[0].message).toContain("3 attempts");
      } finally {
        SCHEDULED_TRANSIENT_RETRY.delayMs = origDelay;
        SCHEDULED_TRANSIENT_RETRY.maxRetries = origMax;
        await deleteTenant(tenant.tenantId);
      }
    });

    it("fails a definitive (non-503) error immediately without retrying", async () => {
      const tenant = await createTenant();
      try {
        const itemId = await insertItem(tenant.tenantId);
        const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter");
        twitterCore.mockResolvedValue({
          ok: false,
          errorStatus: 400,
          error: "Your X connection expired. Reconnect and try again.",
        });

        await runScheduledPublishTick();

        const schedule = await getSchedule(scheduleId);
        expect(schedule.status).toBe("failed");
        expect(schedule.retryCount).toBe(0);
        const notifs = await getNotifications(tenant.tenantId, "scheduled_publish_failed");
        expect(notifs.length).toBe(1);
      } finally {
        await deleteTenant(tenant.tenantId);
      }
    });

    it("a mid-flight cancel wins over the transient re-queue", async () => {
      const tenant = await createTenant();
      try {
        const itemId = await insertItem(tenant.tenantId);
        const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter");
        twitterCore.mockImplementation(async () => {
          await db
            .update(scheduledPostsTable)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(eq(scheduledPostsTable.id, scheduleId));
          return transientOutcome;
        });

        await runScheduledPublishTick();

        const schedule = await getSchedule(scheduleId);
        expect(schedule.status).toBe("cancelled");
        expect(schedule.retryCount).toBe(0);
      } finally {
        await deleteTenant(tenant.tenantId);
      }
    });
  });

  it("a core crash marks the schedule failed rather than leaving it processing", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "instagram");
      instagramCore.mockRejectedValue(new Error("boom"));

      await runScheduledPublishTick();

      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toContain("unexpected error");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("retryScheduledPostNow", () => {
  it("retries a failed schedule on ITS platform and marks it published", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId, "Retry me");
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "linkedin", {
        status: "failed",
      });
      linkedinCore.mockResolvedValue({ ok: true, postId: "li_1", permalink: null });

      const result = await retryScheduledPostNow(tenant.tenantId, scheduleId);

      expect(result.ok).toBe(true);
      expect(linkedinCore).toHaveBeenCalledWith(tenant.tenantId, itemId);
      expect(facebookCore).not.toHaveBeenCalled();
      expect(instagramCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("published");
      expect(schedule.failureReason).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("surfaces the core's error and updates the failureReason on a failed retry", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter", {
        status: "failed",
      });
      twitterCore.mockResolvedValue({
        ok: false,
        errorStatus: 502,
        error: "X rejected the post.",
      });

      const result = await retryScheduledPostNow(tenant.tenantId, scheduleId);

      expect(result).toEqual({ ok: false, status: 502, error: "X rejected the post." });
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toBe("X rejected the post.");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("a user-initiated retry hitting a transient 503 fails immediately (no silent re-queue)", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "twitter", {
        status: "failed",
      });
      twitterCore.mockResolvedValue({
        ok: false,
        errorStatus: 503,
        error: "X is temporarily unavailable.",
      });

      const result = await retryScheduledPostNow(tenant.tenantId, scheduleId);

      expect(result).toEqual({ ok: false, status: 503, error: "X is temporarily unavailable." });
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.retryCount).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("409s when the schedule is not in the failed state", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "facebook", {
        status: "pending",
      });

      const result = await retryScheduledPostNow(tenant.tenantId, scheduleId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(409);
      expect(facebookCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("pending");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("404s for another tenant's schedule", async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "threads", {
        status: "failed",
      });

      const result = await retryScheduledPostNow(other.tenantId, scheduleId);

      expect(result).toEqual({ ok: false, status: 404, error: "Not found" });
      expect(threadsCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
      await deleteTenant(other.tenantId);
    }
  });

  it("409s and reverts to failed (keeping the reason) when the item lock is held", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "linkedin", {
        status: "failed",
      });
      await db
        .update(scheduledPostsTable)
        .set({ failureReason: "original reason" })
        .where(eq(scheduledPostsTable.id, scheduleId));
      const release = tryAcquireResendLock("linkedin", itemId);
      expect(release).not.toBeNull();
      let result;
      try {
        result = await retryScheduledPostNow(tenant.tenantId, scheduleId);
      } finally {
        release!();
      }

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(409);
      expect(linkedinCore).not.toHaveBeenCalled();
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toBe("original reason");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("fails an unsupported platform with a 400 and keeps the row failed", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "youtube", {
        status: "failed",
      });

      const result = await retryScheduledPostNow(tenant.tenantId, scheduleId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("a core crash marks the schedule failed and returns a 500", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertItem(tenant.tenantId);
      const scheduleId = await insertSchedule(tenant.tenantId, itemId, "instagram", {
        status: "failed",
      });
      instagramCore.mockRejectedValue(new Error("boom"));

      const result = await retryScheduledPostNow(tenant.tenantId, scheduleId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(500);
      const schedule = await getSchedule(scheduleId);
      expect(schedule.status).toBe("failed");
      expect(schedule.failureReason).toContain("unexpected error");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
