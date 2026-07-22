import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  pool,
  brandKitsTable,
  usageEventsTable,
  gamificationClaimsTable,
  gamificationPlanSettingsTable,
  tenantsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getGamificationState,
  getStreak,
  claimReward,
  ClaimError,
  questClaimKey,
  streakClaimKey,
} from "./gamification";
import { getCreditBalances } from "./credits";
import { createTenant, deleteTenant, getTenant } from "../test/dbHelpers";

/** Unique per-run plan id so settings rows can never collide with real plans. */
const TEST_PLAN = `gami-test-${Date.now()}`;

let tenantId: number;

async function tenant() {
  return (await getTenant(tenantId))!;
}

async function backdatedUsage(daysAgo: number): Promise<void> {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - daysAgo);
  await db.insert(usageEventsTable).values({
    tenantId,
    kind: "caption",
    createdAt: at,
  });
}

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
  await db
    .update(tenantsTable)
    .set({ plan: TEST_PLAN })
    .where(eq(tenantsTable.id, tenantId));
});

afterAll(async () => {
  await db
    .delete(gamificationClaimsTable)
    .where(eq(gamificationClaimsTable.tenantId, tenantId));
  await db
    .delete(gamificationPlanSettingsTable)
    .where(eq(gamificationPlanSettingsTable.planId, TEST_PLAN));
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId));
  await db.delete(brandKitsTable).where(eq(brandKitsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

describe("quests", () => {
  it("starts incomplete, completes from real data, and pays out once", async () => {
    let state = await getGamificationState(await tenant());
    expect(state.questsEnabled).toBe(true);
    const quest = state.quests.find((q) => q.id === "create_brand_kit")!;
    expect(quest.completed).toBe(false);

    // The claim must be rejected while the underlying action hasn't happened.
    await expect(
      claimReward(await tenant(), questClaimKey("create_brand_kit")),
    ).rejects.toMatchObject({ code: "not_completed" });

    await db.insert(brandKitsTable).values({
      tenantId,
      name: "Test kit",
      slug: `test-kit-${tenantId}`,
    });
    state = await getGamificationState(await tenant());
    expect(state.quests.find((q) => q.id === "create_brand_kit")!.completed).toBe(true);

    const before = await getCreditBalances(tenantId);
    const { granted } = await claimReward(await tenant(), questClaimKey("create_brand_kit"));
    expect(granted.captionCredits).toBe(2); // catalog amount at 100%
    const after = await getCreditBalances(tenantId);
    expect(after.captionCredits).toBe(before.captionCredits + 2);

    // Replay is rejected and grants nothing.
    await expect(
      claimReward(await tenant(), questClaimKey("create_brand_kit")),
    ).rejects.toMatchObject({ code: "already_claimed" });
    expect((await getCreditBalances(tenantId)).captionCredits).toBe(
      after.captionCredits,
    );

    state = await getGamificationState(await tenant());
    expect(state.quests.find((q) => q.id === "create_brand_kit")!.claimed).toBe(true);
  });

  it("rejects unknown claim keys", async () => {
    await expect(claimReward(await tenant(), "quest:no_such_quest")).rejects.toMatchObject(
      { code: "unknown_key" },
    );
    await expect(claimReward(await tenant(), "totally-invalid")).rejects.toMatchObject({
      code: "unknown_key",
    });
  });
});

describe("streaks", () => {
  it("counts consecutive UTC days and pays milestones bound to the run", async () => {
    // Three consecutive days ending today.
    await backdatedUsage(2);
    await backdatedUsage(1);
    await backdatedUsage(0);

    const streak = await getStreak(tenantId);
    expect(streak.currentDays).toBeGreaterThanOrEqual(3);
    expect(streak.activeToday).toBe(true);
    expect(streak.startDate).not.toBeNull();

    // A key from a different (fake) streak run can never be claimed.
    await expect(
      claimReward(await tenant(), streakClaimKey(3, "2000-01-01")),
    ).rejects.toMatchObject({ code: "not_completed" });

    const before = await getCreditBalances(tenantId);
    const { granted } = await claimReward(
      await tenant(),
      streakClaimKey(3, streak.startDate!),
    );
    expect(granted.captionCredits).toBe(1);
    expect(granted.imageCredits).toBe(1);
    const after = await getCreditBalances(tenantId);
    expect(after.imageCredits).toBe(before.imageCredits + 1);

    // Milestones above the current run stay unclaimable.
    await expect(
      claimReward(await tenant(), streakClaimKey(30, streak.startDate!)),
    ).rejects.toMatchObject({ code: "not_completed" });
  });
});

describe("per-plan settings", () => {
  it("applies the reward multiplier and per-plan disable switches", async () => {
    await db.insert(gamificationPlanSettingsTable).values({
      planId: TEST_PLAN,
      rewardMultiplierPercent: 200,
    });

    // 2x multiplier doubles the first_caption quest reward (usage exists from
    // the streak test above, so the quest is completed).
    const { granted } = await claimReward(await tenant(), questClaimKey("first_caption"));
    expect(granted.captionCredits).toBe(4);

    // Turning quests off for the plan hides them and blocks further claims.
    await db
      .update(gamificationPlanSettingsTable)
      .set({ questsEnabled: false })
      .where(eq(gamificationPlanSettingsTable.planId, TEST_PLAN));
    const state = await getGamificationState(await tenant());
    expect(state.questsEnabled).toBe(false);
    expect(state.quests).toHaveLength(0);
    await expect(
      claimReward(await tenant(), questClaimKey("first_image")),
    ).rejects.toBeInstanceOf(ClaimError);
  });
});
