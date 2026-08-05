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
  notifyTextGenFailover,
  resolveTextGenFailoverNotifications,
  TEXTGEN_FAILOVER,
} from "./notifications";
import { createTenant, deleteTenant } from "../test/dbHelpers";

async function rowsFor(tenantId: number) {
  return db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, TEXTGEN_FAILOVER),
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

describe("notifyTextGenFailover", () => {
  it("alerts superadmins once per outage, refreshing the unread row in place", { timeout: SLOW }, async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      await notifyTextGenFailover({
        fromProvider: "openrouter",
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: "503 from upstream",
      });

      let rows = await rowsFor(admin.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.platform).toBe("textgen:openrouter");
      expect(rows[0]!.message).toContain("openrouter");
      expect(rows[0]!.message).toContain("builtin");
      expect(rows[0]!.message).toContain("503 from upstream");

      // Ordinary tenants never see this platform-admin alert.
      expect(await rowsFor(regular.tenantId)).toHaveLength(0);

      // Outage continues: no stacked rows, the unread row is refreshed.
      await notifyTextGenFailover({
        fromProvider: "openrouter",
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: "still down",
      });
      rows = await rowsFor(admin.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toContain("still down");
      expect(rows[0]!.readAt).toBeNull();

      // Resolving re-arms the dedupe: the next outage gets a fresh row.
      await resolveTextGenFailoverNotifications("openrouter");
      await notifyTextGenFailover({
        fromProvider: "openrouter",
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: "down again",
      });
      rows = await rowsFor(admin.tenantId);
      expect(rows).toHaveLength(2);
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });

  it("keeps separate outage scopes per failing provider", { timeout: SLOW }, async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      await notifyTextGenFailover({
        fromProvider: "openrouter",
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: null,
      });
      await notifyTextGenFailover({
        fromProvider: "replicate",
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: null,
      });
      const rows = await rowsFor(admin.tenantId);
      expect(rows.map((r) => r.platform).sort()).toEqual([
        "textgen:openrouter",
        "textgen:replicate",
      ]);

      // Recovery of ONE provider must not clear the other's live outage.
      await resolveTextGenFailoverNotifications("openrouter");
      const after = await rowsFor(admin.tenantId);
      const byScope = new Map(after.map((r) => [r.platform, r.readAt]));
      expect(byScope.get("textgen:openrouter")).not.toBeNull();
      expect(byScope.get("textgen:replicate")).toBeNull();
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});
