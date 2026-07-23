import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  db,
  pool,
  signupCreditSettingsTable,
  featureFlagsTable,
  tenantsTable,
  creditLedgerTable,
  creditBalancesTable,
  type SignupCreditSettings,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getSignupCreditSettings,
  updateSignupCreditSettings,
  maybeGrantSignupCredits,
} from "./signupCredits";
import { invalidateFeatureFlagCache } from "./featureFlags";
import { getCreditBalances, listCreditHistory } from "./credits";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;
let settingsSnapshot: SignupCreditSettings | null = null;
let flagSnapshot: { enabled: boolean } | null = null;

async function setFlag(enabled: boolean) {
  await db
    .insert(featureFlagsTable)
    .values({ feature: "signupCredits", enabled })
    .onConflictDoUpdate({
      target: featureFlagsTable.feature,
      set: { enabled, updatedAt: new Date() },
    });
  invalidateFeatureFlagCache();
}

async function clearFlag() {
  await db
    .delete(featureFlagsTable)
    .where(eq(featureFlagsTable.feature, "signupCredits"));
  invalidateFeatureFlagCache();
}

async function resetGrantMarker() {
  await db
    .update(tenantsTable)
    .set({ signupCreditsGrantedAt: null })
    .where(eq(tenantsTable.id, tenantId));
}

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
  settingsSnapshot =
    (await db.select().from(signupCreditSettingsTable).limit(1))[0] ?? null;
  const flagRow = (
    await db
      .select()
      .from(featureFlagsTable)
      .where(eq(featureFlagsTable.feature, "signupCredits"))
      .limit(1)
  )[0];
  flagSnapshot = flagRow ? { enabled: flagRow.enabled } : null;
});

afterAll(async () => {
  await db.delete(signupCreditSettingsTable);
  if (settingsSnapshot) {
    await db.insert(signupCreditSettingsTable).values({
      enabled: settingsSnapshot.enabled,
      captionCredits: settingsSnapshot.captionCredits,
      imageCredits: settingsSnapshot.imageCredits,
      videoCredits: settingsSnapshot.videoCredits,
    });
  }
  if (flagSnapshot) {
    await setFlag(flagSnapshot.enabled);
  } else {
    await clearFlag();
  }
  await db
    .delete(creditLedgerTable)
    .where(eq(creditLedgerTable.tenantId, tenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(signupCreditSettingsTable);
  await clearFlag();
});

describe("signup credit settings", () => {
  it("defaults to disabled with zero amounts when no row exists", async () => {
    expect(await getSignupCreditSettings()).toEqual({
      enabled: false,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 0,
    });
  });

  it("persists updates via upsert", async () => {
    const updated = await updateSignupCreditSettings({
      enabled: true,
      captionCredits: 5,
      imageCredits: 3,
      videoCredits: 1,
    });
    expect(updated.enabled).toBe(true);
    const again = await updateSignupCreditSettings({
      enabled: false,
      captionCredits: 2,
      imageCredits: 0,
      videoCredits: 0,
    });
    expect(again).toEqual({
      enabled: false,
      captionCredits: 2,
      imageCredits: 0,
      videoCredits: 0,
    });
    expect(
      (await db.select().from(signupCreditSettingsTable)).length,
    ).toBe(1);
  });
});

describe("maybeGrantSignupCredits", () => {
  it("does nothing while settings are disabled", async () => {
    await resetGrantMarker();
    await updateSignupCreditSettings({
      enabled: false,
      captionCredits: 5,
      imageCredits: 5,
      videoCredits: 5,
    });
    expect(await maybeGrantSignupCredits(tenantId)).toBe(false);
  });

  it("does nothing when the kill switch is off, even with settings on", async () => {
    await resetGrantMarker();
    await updateSignupCreditSettings({
      enabled: true,
      captionCredits: 5,
      imageCredits: 5,
      videoCredits: 5,
    });
    await setFlag(false);
    expect(await maybeGrantSignupCredits(tenantId)).toBe(false);
  });

  it("grants the configured bundle exactly once", async () => {
    await resetGrantMarker();
    await updateSignupCreditSettings({
      enabled: true,
      captionCredits: 7,
      imageCredits: 2,
      videoCredits: 1,
    });
    const before = await getCreditBalances(tenantId);
    expect(await maybeGrantSignupCredits(tenantId)).toBe(true);
    const after = await getCreditBalances(tenantId);
    expect(after).toEqual({
      captionCredits: before.captionCredits + 7,
      imageCredits: before.imageCredits + 2,
      videoCredits: before.videoCredits + 1,
    });
    const entry = (await listCreditHistory(tenantId)).find(
      (h) => h.kind === "signup_bonus",
    );
    expect(entry?.captionDelta).toBe(7);
    expect(entry?.note).toBe("Welcome signup bonus");

    // Second call is a no-op: the marker is already set.
    expect(await maybeGrantSignupCredits(tenantId)).toBe(false);
    expect(await getCreditBalances(tenantId)).toEqual(after);
  });

  it("never double-grants under concurrent first requests", async () => {
    await resetGrantMarker();
    await db
      .delete(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenantId));
    await updateSignupCreditSettings({
      enabled: true,
      captionCredits: 1,
      imageCredits: 0,
      videoCredits: 0,
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => maybeGrantSignupCredits(tenantId)),
    );
    expect(results.filter(Boolean).length).toBe(1);
    const entries = (await listCreditHistory(tenantId)).filter(
      (h) => h.kind === "signup_bonus",
    );
    expect(entries.length).toBe(1);
  });

  it("does not grant an all-zero bundle even when enabled", async () => {
    await resetGrantMarker();
    await updateSignupCreditSettings({
      enabled: true,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 0,
    });
    expect(await maybeGrantSignupCredits(tenantId)).toBe(false);
  });
});
