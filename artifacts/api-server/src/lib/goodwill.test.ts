import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("./creditReconciliationGate", () => ({
  CREDIT_RECONCILIATION_GATE: { verdict: "go", reason: "goodwill test override" },
  isCreditEnforcementAllowed: () => true,
  creditEnforcementLockReason: () => "goodwill test override",
}));

import {
  pool,
  db,
  creditAccountLedgerTable,
  creditAccountsTable,
  goodwillSettingsTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_GOODWILL_SETTINGS,
  GOODWILL_REF_KIND,
  checkGoodwillAlarm,
  claimGoodwill,
  goodwillAvailability,
  goodwillReport,
  setGoodwillSettings,
  smartEditFreeCredits,
  applySmartEditGoodwill,
  validateGoodwillSettings,
} from "./goodwill";
import { grantCredits, peekCreditBalance } from "./creditAccounts";
import { invalidateCreditRateCache, setMeterMode } from "./creditRates";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let funded: number;
let quota: number;

async function reset(tenantId: number) {
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
}

beforeAll(async () => {
  funded = (await createTenant()).tenantId;
  quota = (await createTenant()).tenantId;
  await db.update(tenantsTable).set({ billingMode: "credits" }).where(eq(tenantsTable.id, funded));
  await db.update(tenantsTable).set({ billingMode: "quota" }).where(eq(tenantsTable.id, quota));
  await setMeterMode("enforce");
});

beforeEach(async () => {
  invalidateCreditRateCache();
  await reset(funded);
  await reset(quota);
  await db.delete(goodwillSettingsTable);
  await grantCredits({ tenantId: funded, credits: 100, kind: "purchase", idempotencyKey: `seed:${Date.now()}` });
});

afterAll(async () => {
  await setMeterMode("shadow");
  await db.delete(goodwillSettingsTable);
  for (const id of [funded, quota]) {
    await reset(id);
    await deleteTenant(id);
  }
  await pool.end();
});

describe("free part of a Smart Edit", () => {
  const quote = {
    lines: [
      { rateKey: "image_edit", quantity: 2, credits: 6 },
      { rateKey: "video", quantity: 5, credits: 10 },
    ],
  };

  it("covers every frame edit plus the first free seconds of the clip", () => {
    expect(smartEditFreeCredits("change", quote, 3)).toEqual({ freeCredits: 12, freeSeconds: 3 });
  });

  it("covers the whole clip when it is shorter than the free seconds", () => {
    const short = { lines: [{ rateKey: "video", quantity: 3, credits: 6 }] };
    expect(smartEditFreeCredits("regenerate", short, 3)).toEqual({ freeCredits: 6, freeSeconds: 3 });
  });

  it("never makes a New line (voice + lip sync) free", () => {
    expect(smartEditFreeCredits("dialogue", quote, 3)).toEqual({ freeCredits: 0, freeSeconds: 0 });
  });

  it("quotes only the paid part: a 5s edit pays for 2s", () => {
    const full = { credits: 16, ...quote };
    const available = { smartEditFreeAvailable: true, smartEditFreeSeconds: 3, monthlyBudgetLeft: 50 };
    expect(applySmartEditGoodwill(full, "change", available)).toMatchObject({
      fullCredits: 16,
      freeCredits: 12,
      freeSeconds: 3,
      credits: 4,
    });
    // Second edit on the same video, or budget used up: full price.
    expect(applySmartEditGoodwill(full, "change", { ...available, smartEditFreeAvailable: false }).credits).toBe(16);
    expect(applySmartEditGoodwill(full, "change", { ...available, monthlyBudgetLeft: 5 }).credits).toBe(11);
  });
});

describe("claimGoodwill", () => {
  it("grants the free part once per video and records it as goodwill", async () => {
    const before = (await peekCreditBalance(funded)).total;
    expect(await claimGoodwill(funded, { kind: "smart_edit", jobId: 501 }, 8, "Free Smart Edit")).toBe(8);
    expect((await peekCreditBalance(funded)).total).toBe(before + 8);
    // Same video again — Try again, a restored version — is charged.
    expect(await claimGoodwill(funded, { kind: "smart_edit", jobId: 501 }, 8, "Free Smart Edit")).toBe(0);
    // A different video gets its own free edit.
    expect(await claimGoodwill(funded, { kind: "smart_edit", jobId: 502 }, 8, "Free Smart Edit")).toBe(8);
    const rows = await db.select().from(creditAccountLedgerTable).where(and(
      eq(creditAccountLedgerTable.tenantId, funded),
      eq(creditAccountLedgerTable.kind, "goodwill"),
    ));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ refKind: GOODWILL_REF_KIND });
  });

  it("allows the configured number of free image redos per video", async () => {
    await setGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, freeImageRedosPerVideo: 2 });
    const redo = () => claimGoodwill(funded, { kind: "image_redo", jobId: 600 }, 3, "Free redo");
    expect(await redo()).toBe(3);
    expect(await redo()).toBe(3);
    expect(await redo()).toBe(0);
    expect((await goodwillAvailability(funded, 600)).imageRedosLeft).toBe(0);
    expect((await goodwillAvailability(funded, 601)).imageRedosLeft).toBe(2);
  });

  it("stops at the monthly budget", async () => {
    await setGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, monthlyBudgetCredits: 10 });
    expect(await claimGoodwill(funded, { kind: "smart_edit", jobId: 701 }, 8, "x")).toBe(8);
    expect(await claimGoodwill(funded, { kind: "smart_edit", jobId: 702 }, 8, "x")).toBe(0);
    const availability = await goodwillAvailability(funded, 703);
    expect(availability.monthlyBudgetLeft).toBe(2);
  });

  it("gives nothing when switched off or to a workspace not paying in credits", async () => {
    expect(await claimGoodwill(quota, { kind: "smart_edit", jobId: 801 }, 8, "x")).toBe(0);
    expect((await goodwillAvailability(quota, 801)).active).toBe(false);
    await setGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, enabled: false });
    expect(await claimGoodwill(funded, { kind: "smart_edit", jobId: 802 }, 8, "x")).toBe(0);
  });

  it("serialises concurrent claims on the same video", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimGoodwill(funded, { kind: "smart_edit", jobId: 901 }, 4, "x")),
    );
    expect(results.filter((r) => r > 0)).toHaveLength(1);
  });
});

describe("settings, report and alarm", () => {
  it("rejects out-of-range settings", () => {
    expect(() => validateGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, freeSmartEditSeconds: 13 })).toThrow();
    expect(() => validateGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, monthlyBudgetCredits: -1 })).toThrow();
  });

  it("reports today's and this month's goodwill", async () => {
    await claimGoodwill(funded, { kind: "smart_edit", jobId: 1001 }, 5, "x");
    const report = await goodwillReport();
    expect(report.todayCredits).toBeGreaterThanOrEqual(5);
    expect(report.topWorkspaces.some((w) => w.tenantId === funded)).toBe(true);
  });

  it("alerts once per day after crossing the daily alarm", async () => {
    // Claim with the alarm off so the claim's own background check stays quiet.
    await setGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, dailyAlarmCredits: 0 });
    await claimGoodwill(funded, { kind: "smart_edit", jobId: 1101 }, 6, "x");
    await setGoodwillSettings({ ...DEFAULT_GOODWILL_SETTINGS, dailyAlarmCredits: 5 });
    await db.update(goodwillSettingsTable).set({ lastAlarmDate: null });
    const notify = vi.fn().mockResolvedValue(undefined);
    expect(await checkGoodwillAlarm(undefined, notify)).toBe(true);
    expect(await checkGoodwillAlarm(undefined, notify)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
