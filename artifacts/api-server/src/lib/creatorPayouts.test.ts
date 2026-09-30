import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import {
  db, pool, creatorAccountsTable as accounts, creatorCommissionsTable as commissions,
  creatorLedgerAdjustmentsTable as adjustments, creatorPayoutIdentitiesTable as identities,
  creatorPayoutsTable as payouts, type CreatorProgramSettings,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import * as settingsApi from "./creatorProgram";
import * as flags from "./featureFlags";
import * as service from "./creatorPayouts";

let tenantIds: number[], creatorIds: number[], owner: number, settings: CreatorProgramSettings;
const syntheticPan = "ABCDE1234F";
beforeEach(async () => {
  tenantIds = []; creatorIds = [];
  settings = { ...(await settingsApi.getCreatorProgramSettings()), programEnabled: true, minPayoutPaise: 10000, reserveBps: 1000, tdsRateBps: 200, reserveReleaseDays: 90 };
  vi.spyOn(settingsApi.creatorSettingsAccess, "get").mockImplementation(async () => settings);
  vi.spyOn(flags, "getFeatureFlags").mockResolvedValue({ ...(await flags.getFeatureFlags()), creatorProgram: true });
  vi.stubEnv("CREATOR_PII_PEPPER", "test-only-synthetic-payout-pepper-never-use-in-production");
  owner = await creator();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (creatorIds.length) {
    await db.delete(adjustments).where(inArray(adjustments.creatorId, creatorIds));
    await db.delete(commissions).where(inArray(commissions.creatorId, creatorIds));
    await db.delete(payouts).where(inArray(payouts.creatorId, creatorIds));
    await db.delete(identities).where(inArray(identities.creatorId, creatorIds));
    await db.delete(accounts).where(inArray(accounts.id, creatorIds));
  }
  for (const id of tenantIds) await deleteTenant(id);
});
afterAll(async () => { await pool.end(); });
async function creator() {
  const { tenantId } = await createTenant(); tenantIds.push(tenantId);
  const [c] = await db.insert(accounts).values({ tenantId, displayName: "Payout fixture", contactEmail: `payout-test-${tenantId}@example.test`, status: "approved" }).returning();
  creatorIds.push(c!.id); return c!.id;
}
const save = (creatorId = owner, overrides: Partial<service.PayoutIdentityInput> = {}) =>
  service.saveCreatorPayoutIdentity({ creatorId, pan: syntheticPan, accountNumber: "123456789012", ifsc: "TEST0123456", beneficiaryName: "Synthetic Recipient", ...overrides });
async function commission(amount = 100000, creatorId = owner, state = "payable") {
  const [row] = await db.insert(commissions).values({
    creatorId, creatorCodeId: -1, tenantId: tenantIds[0]!, purchaseKind: "credit_pack", purchaseRefId: `payout-test-${crypto.randomUUID()}`,
    grossPaise: amount * 10, netPaise: amount * 10, commissionBps: 1000, commissionPaise: amount, state,
  }).returning();
  return row!;
}
const run = () => service.buildPayoutRun(undefined, undefined, creatorIds);
const history = () => service.listCreatorPayouts(owner);
async function paid(amount = 100000) {
  await save(); const c = await commission(amount);
  await run(); const [p] = await history();
  await service.exportPayoutBatch([p!.id]);
  await service.markPayoutPaid(p!.id, `test-transfer-${p!.id}`);
  return { c, p: (await history())[0]! };
}
it("fails closed without pepper or either program switch, and rejects malformed PII without persistence", async () => {
  for (const [overrides, code] of [
    [{ pan: "not-a-pan" }, "invalid_pan"], [{ accountNumber: "12345abc67890" }, "invalid_account"],
    [{ ifsc: "bad-ifsc" }, "invalid_ifsc"], [{ beneficiaryName: "" }, "invalid_beneficiary"],
  ] as const) await expect(save(owner, overrides)).rejects.toMatchObject({ code });
  vi.stubEnv("CREATOR_PII_PEPPER", "");
  await expect(save()).rejects.toMatchObject({ code: "pii_not_configured" });
  expect(await service.getCreatorPayoutIdentity(owner)).toBeNull();
  settings.programEnabled = false;
  await expect(run()).rejects.toMatchObject({ code: "program_disabled" });
  await expect(save()).rejects.toMatchObject({ code: "program_disabled" });
  settings.programEnabled = true;
  vi.mocked(flags.getFeatureFlags).mockResolvedValue({ ...(await flags.getFeatureFlags()), creatorProgram: false });
  await expect(run()).rejects.toMatchObject({ code: "program_disabled" });
});
it("deduplicates PAN across concurrent saves and version-resets same-owner verification", async () => {
  const other = await creator();
  const result = await Promise.allSettled([save(), save(other)]);
  expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(result.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "pan_in_use" } });
  const winner = result[0]!.status === "fulfilled" ? owner : other;
  const first = (await service.getCreatorPayoutIdentity(winner))!;
  await db.update(identities).set({ verifiedAt: new Date(), verificationRef: "synthetic-verification" }).where(eq(identities.id, first.id));
  const changed = await save(winner, { accountNumber: "987654321000" });
  expect(changed).toMatchObject({ id: first.id, version: 2, verifiedAt: null, verificationRef: null, bankLast4: "1000" });
  expect(JSON.stringify(changed)).not.toContain(syntheticPan);
  expect(JSON.stringify(changed)).not.toContain("987654321000");
  expect(changed.panHash).toHaveLength(64);
});
it("skips below minimum, missing details, and negative balances", async () => {
  await commission(9999);
  expect((await run()).skipped[0]!.reason).toBe("below minimum payout");
  await commission(50000);
  expect((await run()).skipped[0]!.reason).toBe("no payout details on file");
  await save();
  await db.insert(adjustments).values({ creatorId: owner, amountPaise: -100000, kind: "correction" });
  expect((await run()).skipped[0]!.reason).toBe("negative balance");
  expect(await history()).toHaveLength(0);
});
it("concurrent runs claim each commission and each signed adjustment once", async () => {
  await save(); await commission();
  await db.insert(adjustments).values({ creatorId: owner, amountPaise: -20000, kind: "correction" });
  const results = await Promise.all([run(), run()]);
  expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(1);
  expect(await history()).toHaveLength(1);
  expect((await history())[0]).toMatchObject({ grossPaise: 80000, reserveHeldPaise: 8000, tdsPaise: 1440, netPaise: 70560 });
  expect(await service.getPayoutBalance(owner)).toMatchObject({ payablePaise: 0, adjustmentsPaise: 0 });
  await commission(100000);
  await run();
  expect((await history()).map(p => p.grossPaise).sort()).toEqual([100000, 80000].sort());
});
it("uses integer rounding and does not reserve released-reserve-only balances again", async () => {
  expect(service.payoutAmounts(100001, 100001, 1000, 200)).toEqual({ gross: 100001, reserve: 10000, tds: 1800, net: 88201 });
  await save();
  await db.insert(adjustments).values({ creatorId: owner, amountPaise: 12000, kind: "reserve_release" });
  await run();
  expect((await history())[0]).toMatchObject({ grossPaise: 12000, reserveHeldPaise: 0, tdsPaise: 240, netPaise: 11760 });
  expect((await run()).created).toBe(0);
});
it("failed batches restore both commission and adjustment claims, exactly once", async () => {
  await save(); const c = await commission();
  const [entry] = await db.insert(adjustments).values({ creatorId: owner, amountPaise: -20000, kind: "correction" }).returning();
  await run(); const [p] = await history();
  settings.programEnabled = false; // Recovery is not locked behind the kill switch.
  await Promise.all([service.markPayoutFailed(p!.id, "Not sent"), service.markPayoutFailed(p!.id, "Not sent")]);
  expect((await db.select().from(commissions).where(eq(commissions.id, c.id)))[0]).toMatchObject({ state: "payable", payoutId: null });
  expect((await db.select().from(adjustments).where(eq(adjustments.id, entry!.id)))[0]!.consumedByPayoutId).toBeNull();
  settings.programEnabled = true; await run();
  expect((await history()).filter(p => p.status === "draft")[0]!.grossPaise).toBe(80000);
});
it("only reviewed payouts can be marked paid, payment is idempotent, paid cannot fail", async () => {
  await save(); await commission(); await run(); const [p] = await history();
  await expect(service.markPayoutPaid(p!.id, "test-ref")).rejects.toMatchObject({ code: "invalid_state" });
  await service.exportPayoutBatch([p!.id]);
  const paidRows = await Promise.all([service.markPayoutPaid(p!.id, "test-ref"), service.markPayoutPaid(p!.id, "test-ref")]);
  expect(paidRows[0]!.paidAt).toEqual(paidRows[1]!.paidAt);
  await expect(service.markPayoutFailed(p!.id, "Cannot undo bank")).rejects.toMatchObject({ code: "invalid_state" });
  await expect(service.markPayoutPaid(p!.id, "different-ref")).rejects.toMatchObject({ code: "reference_conflict" });
});
it("release uses actual paid date and frozen days, never draft/failed, and serializes", async () => {
  const { p } = await paid();
  settings.reserveReleaseDays = 1;
  await db.update(payouts).set({ paidAt: new Date(Date.now() - 2 * 86400000), createdAt: new Date(0) }).where(eq(payouts.id, p.id));
  expect((await service.releaseMatureReserves([p.id])).released).toBe(0);
  await db.update(payouts).set({ paidAt: new Date(Date.now() - 91 * 86400000) }).where(eq(payouts.id, p.id));
  settings.programEnabled = false;
  const results = await Promise.all([service.releaseMatureReserves([p.id]), service.releaseMatureReserves([p.id])]);
  expect(results.reduce((s, r) => s + r.released, 0)).toBe(1);
  expect((await db.select().from(adjustments).where(eq(adjustments.creatorId, owner))).map(r => r.amountPaise)).toEqual([10000]);
  settings.programEnabled = true; await commission(); await run(); const pending = (await history()).find(p => p.status === "draft")!;
  await db.update(payouts).set({ paidAt: new Date(0) }).where(eq(payouts.id, pending.id));
  expect((await service.releaseMatureReserves([pending.id])).released).toBe(0);
  await service.markPayoutFailed(pending.id, "not transferred");
  expect((await service.releaseMatureReserves([pending.id])).released).toBe(0);
});
it("concurrent clawbacks use reserve first with auditable offsets, never double debit", async () => {
  const { p, c } = await paid();
  const results = await Promise.all([service.clawbackPaidCommission(c.id, "Refund fixture"), service.clawbackPaidCommission(c.id, "Refund fixture")]);
  expect(results.filter(r => r.clawedBack)).toHaveLength(1);
  const entries = await db.select().from(adjustments).where(eq(adjustments.creatorId, owner));
  expect(entries.filter(r => r.kind === "clawback")).toHaveLength(1);
  expect(entries.reduce((sum, r) => sum + r.amountPaise, 0)).toBe(-90000);
  expect((await history())[0]).toMatchObject({ reserveHeldPaise: 10000, reserveConsumedPaise: 10000 });
  await db.update(payouts).set({ paidAt: new Date(0) }).where(eq(payouts.id, p.id));
  await service.releaseMatureReserves([p.id]);
  expect((await service.getPayoutBalance(owner)).owedBackPaise).toBe(90000);
  await commission(190000); await run();
  expect((await history()).find(p => p.status === "draft")!.grossPaise).toBe(100000);
  expect((await service.getPayoutBalance(owner)).adjustmentsPaise).toBe(0);
});
it("a reserve release/clawback race preserves total debt regardless of winner", async () => {
  const { p, c } = await paid();
  await db.update(payouts).set({ paidAt: new Date(0) }).where(eq(payouts.id, p.id));
  await Promise.all([service.releaseMatureReserves([p.id]), service.clawbackPaidCommission(c.id, "refund")]);
  expect((await service.getPayoutBalance(owner)).adjustmentsPaise).toBe(-90000);
});
it("in-flight clawback requires reconciliation and changed destination blocks export/payment", async () => {
  await save(); const c = await commission(); await run(); const [p] = await history();
  await expect(service.clawbackPaidCommission(c.id, "refund")).rejects.toMatchObject({ code: "payout_in_flight" });
  await save(owner, { accountNumber: "987654321000" });
  await expect(service.exportPayoutBatch([p!.id])).rejects.toMatchObject({ code: "destination_changed" });
  expect((await history())[0]!.destinationSnapshot!.bankLast4).toBe("9012");
  await service.markPayoutFailed(p!.id, "Destination changed, transfer not sent");
  await run(); const next = (await history()).find(p => p.status === "draft")!;
  await service.exportPayoutBatch([next.id]);
  await save();
  await expect(service.markPayoutPaid(next.id, "ref")).rejects.toMatchObject({ code: "destination_changed" });
});
it("exports review-only masked snapshots, rejects mixed invalid batches atomically, escapes formulas", async () => {
  await save(owner, { beneficiaryName: "=1+1" }); await commission(); await run(); const [p] = await history();
  await expect(service.exportPayoutBatch([p!.id, 2147483647])).rejects.toMatchObject({ code: "payout_not_found" });
  expect((await history())[0]!.status).toBe("draft");
  const text = await service.exportPayoutBatch([p!.id]);
  expect(text).toContain("REVIEW ONLY"); expect(text).toContain("'=1+1");
  expect(text).not.toContain("123456789012"); expect(text).not.toContain(syntheticPan);
  expect(text).not.toContain((await service.getCreatorPayoutIdentity(owner))!.panHash);
  expect(await service.dispatchPayout(p!.id)).toMatchObject({ dispatched: false });
});
it("rolls the whole run back on a later invalid amount instead of leaving partial claims", async () => {
  await save(); await commission();
  const other = await creator(); await save(other, { pan: "AAAAA5678B" });
  // Valid int columns individually, invalid summed payout.
  for (let i = 0; i < 12; i++) await commission(200000000, other);
  await expect(run()).rejects.toMatchObject({ code: "invalid_amount" });
  expect(await history()).toHaveLength(0);
  expect((await service.getPayoutBalance(owner)).payablePaise).toBe(100000);
});