import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import { db, pool, creatorAccountsTable, creatorCodesTable, creatorAttributionsTable, creatorCommissionsTable, creditAccountsTable, creditAccountLedgerTable, referralAttributionsTable, tenantsTable, type CreatorProgramSettings } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import * as program from "./creatorProgram";
import * as flags from "./featureFlags";
import * as credit from "./creditAccounts";
import { accrueCreatorCommission, matureCreatorCommissions, reverseCreatorCommission, releaseHeldCommission } from "./creatorCommissions";
import { attachReferralAttribution } from "./referralPurchase";

let ids: number[] = [], creatorIds: number[] = [], owner: number, buyer: number;
let settings: CreatorProgramSettings;
beforeEach(async () => {
  owner = (await createTenant()).tenantId;
  buyer = (await createTenant()).tenantId;
  ids = [owner, buyer];
  for (const id of ids) await db.update(tenantsTable).set({ email: `creator-test-${id}@example.test` }).where(eq(tenantsTable.id, id));
  creatorIds = [];
  settings = { ...(await program.getCreatorProgramSettings()), programEnabled: true, newCreatorReviewCount: 0, riskHoldThreshold: 100 };
  vi.spyOn(program.creatorSettingsAccess, "get").mockImplementation(async () => settings);
  const original = await flags.getFeatureFlags();
  vi.spyOn(flags, "getFeatureFlags").mockResolvedValue({ ...original, creatorProgram: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(creatorCommissionsTable).where(inArray(creatorCommissionsTable.tenantId, ids));
  await db.delete(creatorAttributionsTable).where(inArray(creatorAttributionsTable.tenantId, ids));
  await db.delete(referralAttributionsTable).where(inArray(referralAttributionsTable.tenantId, ids));
  if (creatorIds.length) await db.delete(creatorCodesTable).where(inArray(creatorCodesTable.creatorId, creatorIds));
  await db.delete(creatorAccountsTable).where(inArray(creatorAccountsTable.tenantId, ids));
  await db.delete(creditAccountLedgerTable).where(inArray(creditAccountLedgerTable.tenantId, ids));
  await db.delete(creditAccountsTable).where(inArray(creditAccountsTable.tenantId, ids));
  for (const id of ids) await deleteTenant(id);
});
afterAll(async () => { await pool.end(); });
async function apply() {
  const result = await program.applyAsCreator({ tenantId: owner, displayName: "Test Creator", agreementAccepted: true });
  creatorIds.push(result.creator.id);
  return result;
}
async function attach() {
  const a = await apply();
  const approved = await program.reviewCreator(a.creator.id, "approved", owner);
  expect((await program.attachCreatorCode(buyer, approved.code!.code)).ok).toBe(true);
  return approved;
}
const purchase = (refId: string = crypto.randomUUID()) => accrueCreatorCommission({ tenantId: buyer, kind: "credit_pack", refId, totalPaise: 45000 });
const rows = () => db.select().from(creatorCommissionsTable).where(eq(creatorCommissionsTable.tenantId, buyer));

it("blocks participation when disabled without changing persisted settings", async () => {
  settings.programEnabled = false;
  await expect(apply()).rejects.toMatchObject({ code: "program_disabled" });
  expect((await purchase()).reason).toBe("program_disabled");
  expect((await matureCreatorCommissions()).examined).toBe(0);
});
it("application, duplicate rejection, approval replay and default email", async () => {
  const a = await apply();
  expect(a.creator.status).toBe("applied");
  expect(a.code).toBeNull();
  expect(a.creator.contactEmail).toBeTruthy();
  await expect(apply()).rejects.toMatchObject({ code: "duplicate_application" });
  const approved = await Promise.all([program.reviewCreator(a.creator.id, "approved", owner), program.reviewCreator(a.creator.id, "approved", owner)]);
  expect(approved[0].code!.id).toBe(approved[1].code!.id);
  expect(await program.listCreatorCodes(a.creator.id)).toHaveLength(1);
  expect(await program.attachCreatorCode(owner, approved[0].code!.code)).toMatchObject({ ok: false, reason: "own_code" });
});
it("auto-approval issues a code and rejection issues none", async () => {
  settings.autoApproveCreators = true;
  const a = await apply();
  expect(a.code).not.toBeNull();
  expect(a.creator.status).toBe("approved");
  settings.autoApproveCreators = false;
  const b = await program.applyAsCreator({ tenantId: buyer, displayName: "Other", agreementAccepted: true });
  creatorIds.push(b.creator.id);
  expect((await program.reviewCreator(b.creator.id, "rejected", owner)).code).toBeNull();
});
it("suspension blocks attachment and disables codes", async () => {
  const a = await attach();
  await program.setCreatorStatus(a.creator.id, "suspended", owner);
  expect((await program.listCreatorCodes(a.creator.id))[0]!.active).toBe(false);
  expect((await purchase()).reason).toBe("creator_not_approved");
});
it("single-use attachment is serialized across buyers", async () => {
  const a = await attach();
  const code = await program.issueCreatorCode(a.creator.id, { reusePolicy: "single_use" });
  const x = (await createTenant()).tenantId, y = (await createTenant()).tenantId;
  ids.push(x, y);
  const results = await Promise.all([program.attachCreatorCode(x, code.code), program.attachCreatorCode(y, code.code)]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.find(r => !r.ok)).toMatchObject({ reason: "limit_reached" });
});
it("mutual exclusion is permanent and serializes competing program attachments", async () => {
  const a = await attach();
  const x = (await createTenant()).tenantId;
  ids.push(x);
  const promo = { id: 987654321, code: "TEST-REF", ownerTenantId: owner } as Parameters<typeof attachReferralAttribution>[1]["promo"];
  const outcomes = await Promise.all([
    db.transaction(tx => attachReferralAttribution(tx, { tenantId: x, promo, attributionDays: 180 })),
    program.attachCreatorCode(x, a.code!.code),
  ]);
  expect(Number(outcomes[0]) + Number(outcomes[1].ok)).toBe(1);
  expect(await db.transaction(tx => attachReferralAttribution(tx, { tenantId: buyer, promo, attributionDays: 180 }))).toBe(false);
});
it("duplicate accrual grants exactly once and first purchase serializes distinct orders", async () => {
  await attach();
  const results = await Promise.all([purchase("same"), purchase("same")]);
  expect(results.filter(r => r.accrued)).toHaveLength(1);
  expect(await rows()).toHaveLength(1);
  settings.triggerMode = "first_purchase";
  expect((await purchase()).reason).toBe("first_purchase_only");
});
it("first purchase concurrency and rollback of failed buyer grant", async () => {
  await attach();
  settings.triggerMode = "first_purchase";
  const fail = vi.spyOn(credit, "grantCredits").mockRejectedValueOnce(new Error("injected"));
  expect((await purchase("retry")).accrued).toBe(false);
  expect(await rows()).toHaveLength(0);
  fail.mockRestore();
  const results = await Promise.all([purchase("retry"), purchase("other")]);
  expect(results.filter(r => r.accrued)).toHaveLength(1);
});
it("no attribution and global disabled are no-ops", async () => {
  expect((await purchase()).reason).toBe("no_attribution");
  await attach();
  vi.mocked(flags.getFeatureFlags).mockResolvedValue({ ...(await flags.getFeatureFlags()), creatorProgram: false });
  expect((await purchase()).reason).toBe("program_disabled");
  expect((await matureCreatorCommissions()).examined).toBe(0);
});
it("first three are held even below the risk threshold; release and reverse are guarded", async () => {
  await attach();
  settings.newCreatorReviewCount = 3;
  expect((await purchase("held")).state).toBe("held");
  const [row] = await rows();
  expect(row!.buyerBonusCreditsMilli).toBeGreaterThan(0);
  expect((await releaseHeldCommission(row!.id, "Reviewed"))!.state).toBe("pending");
  expect((await reverseCreatorCommission("credit_pack", "held", "Refund")).reversed).toBe(true);
  expect(await releaseHeldCommission(row!.id, "Again")).toBeNull();
  await db.update(creatorCommissionsTable).set({ state: "paid" }).where(eq(creatorCommissionsTable.id, row!.id));
  expect((await reverseCreatorCommission("credit_pack", "held", "Refund")).reversed).toBe(false);
});
it("sixth purchase crosses the tier and override records no tier", async () => {
  const a = await attach();
  for (let i = 0; i < 6; i++) await purchase();
  const all = await rows();
  expect(all[4]!.commissionBps).toBe(1000);
  expect(all[5]!.commissionBps).toBe(1200);
  await db.update(creatorAccountsTable).set({ commissionOverrideBps: 1700 }).where(eq(creatorAccountsTable.id, a.creator.id));
  await purchase("override");
  const override = (await rows()).find(r => r.purchaseRefId === "override")!;
  expect(override.commissionBps).toBe(1700);
  expect(override.slabIndex).toBeNull();
});
it("maturation requires hold and post-purchase consumption; payable expires", async () => {
  await attach();
  await purchase("mature");
  const [row] = await rows();
  expect((await matureCreatorCommissions()).matured).toBe(0);
  await db.update(creatorCommissionsTable).set({ holdUntil: new Date(Date.now() - 1000) }).where(eq(creatorCommissionsTable.id, row!.id));
  await db.insert(creditAccountLedgerTable).values({
    tenantId: buyer, kind: "spend", purchasedDeltaMilli: -row!.creditsPurchasedMilli,
    grantedDeltaMilli: 0, createdAt: new Date(row!.createdAt.getTime() - 60000),
    idempotencyKey: `creator-test-old:${crypto.randomUUID()}`,
  });
  expect((await matureCreatorCommissions()).matured).toBe(0);
  await db.insert(creditAccountLedgerTable).values({
    tenantId: buyer, kind: "spend", purchasedDeltaMilli: -row!.creditsPurchasedMilli,
    grantedDeltaMilli: 0,
    idempotencyKey: `creator-test-spend:${crypto.randomUUID()}`,
  });
  expect((await matureCreatorCommissions()).matured).toBe(1);
  await db.update(creatorCommissionsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(creatorCommissionsTable.id, row!.id));
  expect((await matureCreatorCommissions()).expired).toBe(1);
});