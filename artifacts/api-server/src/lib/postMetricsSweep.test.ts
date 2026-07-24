import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";

const fetcherMock = vi.fn();

vi.mock("./postMetrics", async () => {
  const actual =
    await vi.importActual<typeof import("./postMetrics")>("./postMetrics");
  return {
    ...actual,
    METRICS_FETCHERS: {
      facebook: (...args: unknown[]) => fetcherMock(...args),
      instagram: (...args: unknown[]) => fetcherMock(...args),
      linkedin: (...args: unknown[]) => fetcherMock(...args),
    },
  };
});

import { db, pool, postMetricsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { pollDueMetrics } from "./postMetricsSweep";
import {
  METRICS_HOT_INTERVAL_MS,
  METRICS_TRACKING_WINDOW_MS,
} from "./postMetrics";

let tenant: TestTenant;

beforeEach(async () => {
  fetcherMock.mockReset();
  tenant = await createTenant();
});

afterEach(async () => {
  await db
    .delete(postMetricsTable)
    .where(eq(postMetricsTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
});

afterAll(async () => {
  await pool.end();
});

async function seedRow(overrides: Partial<typeof postMetricsTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(postMetricsTable)
    .values({
      tenantId: tenant.tenantId,
      contentItemId: -1 * Math.floor(Math.random() * 1_000_000) - 1,
      platform: "facebook",
      postId: `fb_${Math.random()}`,
      publishedAt: new Date(Date.now() - 60 * 60 * 1000),
      nextPollAt: new Date(Date.now() - 1000),
      pollState: "active",
      ...overrides,
    })
    .returning();
  return row;
}

describe("pollDueMetrics state transitions", () => {
  it("success on a young post updates counters and stays active", async () => {
    const row = await seedRow();
    fetcherMock.mockResolvedValue({
      ok: true,
      counters: { likes: 12, comments: 3, shares: 1, impressions: 200 },
    });

    await pollDueMetrics();

    const [after] = await db
      .select()
      .from(postMetricsTable)
      .where(eq(postMetricsTable.id, row.id));
    expect(after.likes).toBe(12);
    expect(after.pollState).toBe("active");
    expect(after.nextPollAt).not.toBeNull();
    expect(after.failureReason).toBeNull();
  });

  it("success past the tracking window marks the row done", async () => {
    const row = await seedRow({
      publishedAt: new Date(Date.now() - METRICS_TRACKING_WINDOW_MS - 1000),
    });
    fetcherMock.mockResolvedValue({
      ok: true,
      counters: { likes: 1, comments: 0, shares: 0, impressions: 5 },
    });

    await pollDueMetrics();

    const [after] = await db
      .select()
      .from(postMetricsTable)
      .where(eq(postMetricsTable.id, row.id));
    expect(after.pollState).toBe("done");
    expect(after.nextPollAt).toBeNull();
  });

  it("transient failure backs off one hot interval and keeps counters", async () => {
    const row = await seedRow({ likes: 9 });
    fetcherMock.mockResolvedValue({
      ok: false,
      transient: true,
      error: "platform 503",
    });

    const before = Date.now();
    await pollDueMetrics();

    const [after] = await db
      .select()
      .from(postMetricsTable)
      .where(eq(postMetricsTable.id, row.id));
    expect(after.pollState).toBe("active");
    expect(after.likes).toBe(9);
    expect(after.failureReason).toBe("platform 503");
    expect(after.nextPollAt!.getTime()).toBeGreaterThanOrEqual(
      before + METRICS_HOT_INTERVAL_MS - 5000,
    );
  });

  it("definitive rejection marks the row failed and stops polling", async () => {
    const row = await seedRow();
    fetcherMock.mockResolvedValue({
      ok: false,
      transient: false,
      error: "post deleted",
    });

    await pollDueMetrics();

    const [after] = await db
      .select()
      .from(postMetricsTable)
      .where(eq(postMetricsTable.id, row.id));
    expect(after.pollState).toBe("failed");
    expect(after.nextPollAt).toBeNull();
    expect(after.failureReason).toBe("post deleted");
  });

  it("claims rows atomically: a row is not re-polled once claimed", async () => {
    const row = await seedRow();
    fetcherMock.mockResolvedValue({
      ok: false,
      transient: true,
      error: "timeout",
    });

    await pollDueMetrics();
    expect(fetcherMock).toHaveBeenCalledTimes(1);

    // nextPollAt was pushed into the future by the claim, so a second tick
    // must not pick the row up again.
    await pollDueMetrics();
    expect(fetcherMock).toHaveBeenCalledTimes(1);

    const [after] = await db
      .select()
      .from(postMetricsTable)
      .where(eq(postMetricsTable.id, row.id));
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("ignores rows that are not due or not active", async () => {
    await seedRow({ nextPollAt: new Date(Date.now() + 60_000) });
    await seedRow({ pollState: "done", nextPollAt: null });
    await seedRow({ pollState: "failed", nextPollAt: null });

    await pollDueMetrics();
    expect(fetcherMock).not.toHaveBeenCalled();
  });
});
