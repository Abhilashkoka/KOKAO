import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  pool,
  promoCodesTable,
  promoRedemptionsTable,
  promoRedemptionFailuresTable,
  tenantsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  redeemPromoCode,
  normalizePromoCode,
  generatePromoCode,
  getPromoMetrics,
} from "./promoCodes";
import { getCreditBalances, listCreditHistory } from "./credits";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;
const promoIds: number[] = [];
const suffix = Date.now().toString(36).toUpperCase();

async function insertPromo(
  values: Partial<typeof promoCodesTable.$inferInsert> & { code: string },
) {
  const [row] = await db
    .insert(promoCodesTable)
    .values({
      captionCredits: 3,
      imageCredits: 2,
      ...values,
    })
    .returning();
  promoIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
});

afterAll(async () => {
  if (promoIds.length > 0) {
    await db
      .delete(promoRedemptionsTable)
      .where(inArray(promoRedemptionsTable.promoCodeId, promoIds));
    await db.delete(promoCodesTable).where(inArray(promoCodesTable.id, promoIds));
  }
  await db
    .delete(promoRedemptionFailuresTable)
    .where(eq(promoRedemptionFailuresTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

describe("promo code helpers", () => {
  it("normalizes codes to trimmed uppercase", () => {
    expect(normalizePromoCode("  welcome25 ")).toBe("WELCOME25");
  });

  it("generates codes from the unambiguous alphabet, with optional prefix", () => {
    const plain = generatePromoCode();
    expect(plain).toMatch(/^[A-HJ-KM-NP-Z2-9]{10}$/);
    const prefixed = generatePromoCode("launch!");
    expect(prefixed).toMatch(/^LAUNCH-[A-HJ-KM-NP-Z2-9]{10}$/);
  });
});

describe("redeemPromoCode", () => {
  it("rejects unknown codes and records a failure", async () => {
    const result = await redeemPromoCode(tenantId, `NOPE-${suffix}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_code");
    const failures = await db
      .select()
      .from(promoRedemptionFailuresTable)
      .where(eq(promoRedemptionFailuresTable.tenantId, tenantId));
    expect(failures.some((f) => f.reason === "invalid_code")).toBe(true);
  });

  it("redeems a valid code once, grants credits, and writes the ledger", async () => {
    const promo = await insertPromo({ code: `OK-${suffix}` });
    const result = await redeemPromoCode(tenantId, `  ok-${suffix} `);
    expect(result.ok).toBe(true);
    expect(await getCreditBalances(tenantId)).toEqual({
      captionCredits: 3,
      imageCredits: 2,
      videoCredits: 0,
    });
    const history = await listCreditHistory(tenantId);
    const entry = history.find((h) => h.kind === "promo");
    expect(entry?.note).toBe(`Promo code OK-${suffix}`);

    // Default per-tenant limit is 1: a second attempt is rejected.
    const again = await redeemPromoCode(tenantId, promo.code);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("per_tenant_limit_reached");
    expect(await getCreditBalances(tenantId)).toEqual({
      captionCredits: 3,
      imageCredits: 2,
      videoCredits: 0,
    });

    const [updated] = await db
      .select()
      .from(promoCodesTable)
      .where(eq(promoCodesTable.id, promo.id));
    expect(updated.redemptionCount).toBe(1);
  });

  it("grants video credits and includes them in the message and metrics", async () => {
    const promo = await insertPromo({
      code: `VID-${suffix}`,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 4,
    });
    const before = await getCreditBalances(tenantId);
    const result = await redeemPromoCode(tenantId, promo.code);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videoCredits).toBe(4);
      expect(result.message).toContain("4 video credits");
    }
    const after = await getCreditBalances(tenantId);
    expect(after.videoCredits).toBe(before.videoCredits + 4);
    const history = await listCreditHistory(tenantId);
    const entry = history.find((h) => h.note === `Promo code VID-${suffix}`);
    expect(entry?.videoDelta).toBe(4);

    const metrics = await getPromoMetrics();
    expect(metrics.totalVideoCredits).toBeGreaterThanOrEqual(4);
  });

  it("rejects inactive, not-started, and expired codes", async () => {
    const inactive = await insertPromo({ code: `OFF-${suffix}`, active: false });
    const future = await insertPromo({
      code: `SOON-${suffix}`,
      startsAt: new Date(Date.now() + 86_400_000),
    });
    const past = await insertPromo({
      code: `OLD-${suffix}`,
      expiresAt: new Date(Date.now() - 1000),
    });
    for (const [promo, reason] of [
      [inactive, "inactive"],
      [future, "not_started"],
      [past, "expired"],
    ] as const) {
      const result = await redeemPromoCode(tenantId, promo.code);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  it("enforces the global redemption cap", async () => {
    const promo = await insertPromo({
      code: `CAP-${suffix}`,
      maxRedemptions: 1,
      redemptionCount: 1,
    });
    const result = await redeemPromoCode(tenantId, promo.code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("global_limit_reached");
  });

  it("enforces plan restrictions", async () => {
    const promo = await insertPromo({
      code: `PRO-${suffix}`,
      allowedPlans: ["pro"],
    });
    const result = await redeemPromoCode(tenantId, promo.code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("plan_not_allowed");
  });

  it("enforces new/existing audience targeting", async () => {
    // The test tenant was just created, so it counts as "new".
    const existingOnly = await insertPromo({
      code: `EXIST-${suffix}`,
      audience: "existing",
    });
    const rejected = await redeemPromoCode(tenantId, existingOnly.code);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe("audience_existing_only");

    // Age the tenant past the window and a new-only code must reject.
    await db
      .update(tenantsTable)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(tenantsTable.id, tenantId));
    const newOnly = await insertPromo({
      code: `NEW-${suffix}`,
      audience: "new",
      newTenantDays: 30,
    });
    const rejectedNew = await redeemPromoCode(tenantId, newOnly.code);
    expect(rejectedNew.ok).toBe(false);
    if (!rejectedNew.ok) expect(rejectedNew.reason).toBe("audience_new_only");

    // Now the existing-only code should work.
    const accepted = await redeemPromoCode(tenantId, existingOnly.code);
    expect(accepted.ok).toBe(true);
  });

  it("honours a per-tenant limit above one", async () => {
    const promo = await insertPromo({
      code: `TWICE-${suffix}`,
      perTenantLimit: 2,
      captionCredits: 1,
      imageCredits: 0,
    });
    expect((await redeemPromoCode(tenantId, promo.code)).ok).toBe(true);
    expect((await redeemPromoCode(tenantId, promo.code)).ok).toBe(true);
    const third = await redeemPromoCode(tenantId, promo.code);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe("per_tenant_limit_reached");
  });

  it("never oversubscribes a capped code under concurrent redemption", async () => {
    const promo = await insertPromo({
      code: `RACE-${suffix}`,
      maxRedemptions: 1,
      perTenantLimit: 10,
      captionCredits: 1,
      imageCredits: 0,
    });
    const before = await getCreditBalances(tenantId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => redeemPromoCode(tenantId, promo.code)),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    const after = await getCreditBalances(tenantId);
    expect(after.captionCredits).toBe(before.captionCredits + 1);
    const [row] = await db
      .select()
      .from(promoCodesTable)
      .where(eq(promoCodesTable.id, promo.id));
    expect(row.redemptionCount).toBe(1);
  });

  it("aggregates redemptions into metrics", async () => {
    const metrics = await getPromoMetrics();
    expect(metrics.totalRedemptions).toBeGreaterThanOrEqual(4);
    expect(metrics.byPlan.length).toBeGreaterThan(0);
  });
});
