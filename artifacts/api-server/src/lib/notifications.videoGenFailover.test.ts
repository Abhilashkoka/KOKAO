import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Stub the side channels so the test stays hermetic against Clerk/SendGrid.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => "admin@example.com"),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { db, notificationsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  notifyVideoGenFailover,
  resolveVideoGenFailoverNotifications,
  VIDEOGEN_FAILOVER,
} from "./notifications";
import { createTenant, deleteTenant } from "../test/dbHelpers";

async function rowsFor(tenantId: number) {
  return db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, VIDEOGEN_FAILOVER),
      ),
    );
}

async function rowsForScope(tenantId: number, platform: string) {
  return db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, VIDEOGEN_FAILOVER),
        eq(notificationsTable.platform, platform),
      ),
    );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

function testProvider(): string {
  return `__test__:replicate:${randomUUID()}`;
}

async function purgeTestScope(provider: string): Promise<void> {
  await db
    .delete(notificationsTable)
    .where(
      and(
        eq(notificationsTable.type, VIDEOGEN_FAILOVER),
        eq(notificationsTable.platform, `videogen:${provider}`),
      ),
    );
}

// Fan-out iterates every superadmin in the shared dev DB, so these tests are
// slow under a full parallel run — give them room instead of flaking at 30s.
const SLOW = 120_000;

describe("notifyVideoGenFailover", () => {
  it("alerts superadmins once per outage, refreshing the unread row, and resolves on recovery", { timeout: SLOW }, async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    const provider = testProvider();
    try {
      await db.insert(notificationsTable).values({
        tenantId: admin.tenantId,
        type: VIDEOGEN_FAILOVER,
        platform: "videogen:replicate",
        title: "Operational video outage",
        message: "This real alert must survive the test.",
        linkUrl: "/admin",
        inApp: true,
      });

      await notifyVideoGenFailover({
        fromProvider: provider,
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "503 from upstream",
      });

      let rows = await rowsForScope(admin.tenantId, `videogen:${provider}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.platform).toBe(`videogen:${provider}`);
      expect(rows[0]!.message).toContain(provider);
      expect(rows[0]!.message).toContain("openrouter");
      expect(rows[0]!.message).toContain("503 from upstream");

      // Ordinary tenants never see this platform-admin alert.
      expect(await rowsFor(regular.tenantId)).toHaveLength(0);

      // Outage continues: no stacked rows, the unread row is refreshed.
      await notifyVideoGenFailover({
        fromProvider: provider,
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "still down",
      });
      rows = await rowsForScope(admin.tenantId, `videogen:${provider}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toContain("still down");
      expect(rows[0]!.readAt).toBeNull();

      // Recovery clears the banner and re-arms the dedupe.
      await resolveVideoGenFailoverNotifications(provider);
      rows = await rowsForScope(admin.tenantId, `videogen:${provider}`);
      expect(rows[0]!.readAt).not.toBeNull();
      await notifyVideoGenFailover({
        fromProvider: provider,
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "down again",
      });
      rows = await rowsForScope(admin.tenantId, `videogen:${provider}`);
      expect(rows).toHaveLength(2);

      await purgeTestScope(provider);
      const operational = await rowsForScope(
        admin.tenantId,
        "videogen:replicate",
      );
      expect(operational).toHaveLength(1);
      expect(operational[0]!.message).toBe(
        "This real alert must survive the test.",
      );
      expect(operational[0]!.readAt).toBeNull();
    } finally {
      try {
        await purgeTestScope(provider);
      } finally {
        await deleteTenant(admin.tenantId);
        await deleteTenant(regular.tenantId);
      }
    }
  });
});
