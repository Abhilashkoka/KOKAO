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
import { and, eq, inArray } from "drizzle-orm";
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

async function rowsForScope(tenantId: number, platform: string) {
  return db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, TEXTGEN_FAILOVER),
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

function testProvider(label: string): string {
  return `__test__:${label}:${randomUUID()}`;
}

async function purgeTestScopes(...providers: string[]): Promise<void> {
  await db
    .delete(notificationsTable)
    .where(
      and(
        eq(notificationsTable.type, TEXTGEN_FAILOVER),
        inArray(
          notificationsTable.platform,
          providers.map((provider) => `textgen:${provider}`),
        ),
      ),
    );
}

// Fan-out iterates every superadmin in the shared dev DB, so these tests are
// slow under a full parallel run — give them room instead of flaking at 30s.
const SLOW = 120_000;

describe("notifyTextGenFailover", () => {
  it("alerts superadmins once per outage, refreshing the unread row in place", { timeout: SLOW }, async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    const provider = testProvider("openrouter");
    try {
      await db.insert(notificationsTable).values({
        tenantId: admin.tenantId,
        type: TEXTGEN_FAILOVER,
        platform: "textgen:openrouter",
        title: "Operational text outage",
        message: "This real alert must survive the test.",
        linkUrl: "/admin",
        inApp: true,
      });

      await notifyTextGenFailover({
        fromProvider: provider,
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: "503 from upstream",
      });

      let rows = await rowsForScope(admin.tenantId, `textgen:${provider}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.platform).toBe(`textgen:${provider}`);
      expect(rows[0]!.message).toContain(provider);
      expect(rows[0]!.message).toContain("builtin");
      expect(rows[0]!.message).toContain("503 from upstream");

      // Ordinary tenants never see this platform-admin alert.
      expect(await rowsFor(regular.tenantId)).toHaveLength(0);

      // Outage continues: no stacked rows, the unread row is refreshed.
      await notifyTextGenFailover({
        fromProvider: provider,
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: "still down",
      });
      rows = await rowsForScope(admin.tenantId, `textgen:${provider}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toContain("still down");
      expect(rows[0]!.readAt).toBeNull();

      // Resolving re-arms the dedupe: the next outage gets a fresh row.
      await resolveTextGenFailoverNotifications(provider);
      await notifyTextGenFailover({
        fromProvider: provider,
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: "down again",
      });
      rows = await rowsForScope(admin.tenantId, `textgen:${provider}`);
      expect(rows).toHaveLength(2);

      await purgeTestScopes(provider);
      const operational = await rowsForScope(
        admin.tenantId,
        "textgen:openrouter",
      );
      expect(operational).toHaveLength(1);
      expect(operational[0]!.message).toBe(
        "This real alert must survive the test.",
      );
      expect(operational[0]!.readAt).toBeNull();
    } finally {
      try {
        await purgeTestScopes(provider);
      } finally {
        await deleteTenant(admin.tenantId);
        await deleteTenant(regular.tenantId);
      }
    }
  });

  it("keeps separate outage scopes per failing provider", { timeout: SLOW }, async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const openrouter = testProvider("openrouter");
    const replicate = testProvider("replicate");
    try {
      await notifyTextGenFailover({
        fromProvider: openrouter,
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: null,
      });
      await notifyTextGenFailover({
        fromProvider: replicate,
        toProvider: "builtin",
        model: "gpt-5.4",
        lastError: null,
      });
      const rows = await rowsFor(admin.tenantId);
      expect(rows.map((r) => r.platform).sort()).toEqual([
        `textgen:${openrouter}`,
        `textgen:${replicate}`,
      ]);

      // Recovery of ONE provider must not clear the other's live outage.
      await resolveTextGenFailoverNotifications(openrouter);
      const after = await rowsFor(admin.tenantId);
      const byScope = new Map(after.map((r) => [r.platform, r.readAt]));
      expect(byScope.get(`textgen:${openrouter}`)).not.toBeNull();
      expect(byScope.get(`textgen:${replicate}`)).toBeNull();
    } finally {
      try {
        await purgeTestScopes(openrouter, replicate);
      } finally {
        await deleteTenant(admin.tenantId);
      }
    }
  });
});
