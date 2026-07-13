import { describe, it, expect, afterAll } from "vitest";
import { db, pool, brandKitsTable, brandKitVersionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../../test/dbHelpers";
import { createKit } from "./service";

describe("createKit invariants", () => {
  const tenants: number[] = [];

  afterAll(async () => {
    for (const id of tenants) {
      await db
        .delete(brandKitVersionsTable)
        .where(eq(brandKitVersionsTable.tenantId, id));
      await db.delete(brandKitsTable).where(eq(brandKitsTable.tenantId, id));
      await deleteTenant(id);
    }
    await pool.end();
  });

  it("always activates version 1 with an approved status", async () => {
    const tenant = await createTenant();
    tenants.push(tenant.tenantId);

    const detail = await createKit({
      tenantId: tenant.tenantId,
      plan: "free",
      createdBy: tenant.clerkUserId,
      name: "Invariant Test Brand",
      payload: null,
    });

    expect(detail).not.toBeNull();
    expect(detail!.activeVersionId).not.toBeNull();
    expect(detail!.activeVersion).not.toBeNull();
    expect(detail!.activeVersion!.approvalStatus).toBe("approved");
    expect(detail!.status).toBe("active");
    expect(detail!.activeVersion!.payload.brand_controls.approval_status).toBe(
      "approved",
    );
  });
});
