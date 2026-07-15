import { describe, it, expect, afterAll } from "vitest";
import { db, contentItemsTable, notificationsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTenant, deleteTenant, getContentItem } from "../test/dbHelpers";
import {
  recoverStuckPublishingItems,
  PUBLISH_INTERRUPTED_REASON,
} from "./recoverStuckPublishes";
import { PUBLISH_INTERRUPTED } from "./notifications";

async function setPublishing(id: number, tenantId: number, updatedAt: Date) {
  await db
    .update(contentItemsTable)
    .set({ status: "publishing", updatedAt })
    .where(eq(contentItemsTable.id, id));
  // Sanity: confirm the row is in the expected state.
  const item = await getContentItem(id, tenantId);
  expect(item.status).toBe("publishing");
}

async function insertItem(tenantId: number): Promise<number> {
  const [row] = await db
    .insert(contentItemsTable)
    .values({ tenantId, title: "Stuck post", caption: "hi" })
    .returning();
  return row.id;
}

afterAll(async () => {
  await pool.end();
});

describe("recoverStuckPublishingItems", () => {
  it("marks a long-stuck 'publishing' item as 'failed'", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertItem(tenant.tenantId);
      // Stuck for 30 minutes — well past the timeout.
      await setPublishing(
        id,
        tenant.tenantId,
        new Date(Date.now() - 30 * 60 * 1000),
      );

      const count = await recoverStuckPublishingItems();
      expect(count).toBeGreaterThanOrEqual(1);

      const item = await getContentItem(id, tenant.tenantId);
      expect(item.status).toBe("failed");
      // The user-visible reason distinguishes a restart interruption from a
      // real platform rejection.
      expect(item.failureReason).toBe(PUBLISH_INTERRUPTED_REASON);

      // An in-app notification is recorded for the affected tenant.
      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.tenantId),
            eq(notificationsTable.type, PUBLISH_INTERRUPTED),
          ),
        );
      expect(notifications.length).toBe(1);
      expect(notifications[0].message).toContain("server restarted");
      expect(notifications[0].linkUrl).toBe("/library");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not stack a second notification while one is unread", async () => {
    const tenant = await createTenant();
    try {
      const first = await insertItem(tenant.tenantId);
      await setPublishing(
        first,
        tenant.tenantId,
        new Date(Date.now() - 30 * 60 * 1000),
      );
      await recoverStuckPublishingItems();

      const second = await insertItem(tenant.tenantId);
      await setPublishing(
        second,
        tenant.tenantId,
        new Date(Date.now() - 30 * 60 * 1000),
      );
      await recoverStuckPublishingItems();

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.tenantId),
            eq(notificationsTable.type, PUBLISH_INTERRUPTED),
          ),
        );
      expect(notifications.length).toBe(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("leaves a recently-updated 'publishing' item alone (in-flight elsewhere)", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertItem(tenant.tenantId);
      // Updated just now — could be a live job on another instance.
      await setPublishing(id, tenant.tenantId, new Date());

      await recoverStuckPublishingItems();

      const item = await getContentItem(id, tenant.tenantId);
      expect(item.status).toBe("publishing");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not touch items in other statuses", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertItem(tenant.tenantId);
      // Old draft — should never be reclaimed regardless of age.
      await db
        .update(contentItemsTable)
        .set({ status: "draft", updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(contentItemsTable.id, id));

      await recoverStuckPublishingItems();

      const item = await getContentItem(id, tenant.tenantId);
      expect(item.status).toBe("draft");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("respects a custom timeout argument", async () => {
    const tenant = await createTenant();
    try {
      const id = await insertItem(tenant.tenantId);
      // Stuck for 5 seconds; a 1ms timeout should reclaim it.
      await setPublishing(id, tenant.tenantId, new Date(Date.now() - 5000));

      const count = await recoverStuckPublishingItems(1);
      expect(count).toBeGreaterThanOrEqual(1);

      const item = await getContentItem(id, tenant.tenantId);
      expect(item.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
