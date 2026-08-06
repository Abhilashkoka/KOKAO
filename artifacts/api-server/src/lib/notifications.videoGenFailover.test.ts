import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

// Fan-out iterates every superadmin in the shared dev DB, so these tests are
// slow under a full parallel run — give them room instead of flaking at 30s.
const SLOW = 120_000;

describe("notifyVideoGenFailover", () => {
  it("alerts superadmins once per outage, refreshing the unread row, and resolves on recovery", { timeout: SLOW }, async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      await notifyVideoGenFailover({
        fromProvider: "replicate",
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "503 from upstream",
      });

      let rows = await rowsFor(admin.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.platform).toBe("videogen:replicate");
      expect(rows[0]!.message).toContain("replicate");
      expect(rows[0]!.message).toContain("openrouter");
      expect(rows[0]!.message).toContain("503 from upstream");

      // Ordinary tenants never see this platform-admin alert.
      expect(await rowsFor(regular.tenantId)).toHaveLength(0);

      // Outage continues: no stacked rows, the unread row is refreshed.
      await notifyVideoGenFailover({
        fromProvider: "replicate",
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "still down",
      });
      rows = await rowsFor(admin.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toContain("still down");
      expect(rows[0]!.readAt).toBeNull();

      // Recovery clears the banner and re-arms the dedupe.
      await resolveVideoGenFailoverNotifications("replicate");
      rows = await rowsFor(admin.tenantId);
      expect(rows[0]!.readAt).not.toBeNull();
      await notifyVideoGenFailover({
        fromProvider: "replicate",
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "down again",
      });
      rows = await rowsFor(admin.tenantId);
      expect(rows).toHaveLength(2);
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });
});
