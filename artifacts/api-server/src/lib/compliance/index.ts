import { db, tenantsTable, type FrozenJobCompliance } from "@workspace/db";
import { eq } from "drizzle-orm";
import { loadActivePayload } from "../brandKit/service";
import { resolveSelection } from "../brandKit/selection";
import { freezeCompliance, resolveCompliance } from "./profile";

export * from "./check";
export * from "./gates";
export * from "./profile";
export * from "./prompt";
export * from "./rulePacks";

async function tenantIndustry(tenantId: number): Promise<string | null> {
  const row = (
    await db
      .select({ industry: tenantsTable.industry })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
  return row?.industry ?? null;
}

/**
 * The compliance snapshot to freeze onto a new video job.
 *
 * Deliberately independent of the brandVideo kill switch and of whether the
 * user attached a kit: a doctor who forgets to pick a kit is still a doctor.
 * Order: the job's kit → the tenant's default kit → tenant Business/Industry.
 * Fail-closed on lookup errors is NOT appropriate here (it would block every
 * tenant on a DB hiccup), so errors fall through to the industry check.
 */
export async function resolveJobCompliance(
  tenantId: number,
  brandKitId: number | null | undefined,
): Promise<FrozenJobCompliance | null> {
  let kitId: number | null = brandKitId ?? null;
  if (kitId == null) {
    try {
      const selected = await resolveSelection(tenantId, {});
      kitId = selected.status === "resolved" ? (selected.brandKit?.id ?? null) : null;
    } catch {
      kitId = null;
    }
  }
  const [loaded, industry] = await Promise.all([
    kitId != null ? loadActivePayload(tenantId, kitId).catch(() => null) : Promise.resolve(null),
    tenantIndustry(tenantId).catch(() => null),
  ]);
  return freezeCompliance(resolveCompliance(loaded?.payload ?? null, industry), loaded ? kitId : null);
}
