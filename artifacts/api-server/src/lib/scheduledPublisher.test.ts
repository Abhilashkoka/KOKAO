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
  SCHEDULE_INTERRUPTED_REASON,
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
