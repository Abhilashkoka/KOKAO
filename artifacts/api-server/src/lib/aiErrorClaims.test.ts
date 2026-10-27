import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("./creditReconciliationGate", () => ({
  CREDIT_RECONCILIATION_GATE: { verdict: "go", reason: "claims test override" },
  isCreditEnforcementAllowed: () => true,
  creditEnforcementLockReason: () => "claims test override",
}));

import {
  pool,
  db,
  aiErrorClaimsTable,
  aiErrorGuaranteeSettingsTable,
  creditAccountLedgerTable,
  creditAccountsTable,
  tenantsTable,
  videoGenerationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_GUARANTEE_SETTINGS,
  ClaimError,
  claimEligibility,
  claimsReport,
  decideClaim,
  fileClaim,
  setGuaranteeSettings,
  suggestRefundCredits,
  validateGuaranteeSettings,
} from "./aiErrorClaims";
import { grantCredits, peekCreditBalance } from "./creditAccounts";
import { getVideoJobCreditReceipt } from "./creditReceipt";
import { invalidateCreditRateCache, setMeterMode } from "./creditRates";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;
let quotaTenant: number;
let seq = 0;

/** A finished video that cost `spent` credits. */
async function paidVideo(spent = 40, owner = tenantId, createdAt = new Date()) {
  const [job] = await db
    .insert(videoGenerationsTable)
    .values({ tenantId: owner, engine: "topic_to_video", status: "succeeded", videoPath: "/objects/x/v.mp4", createdAt } as never)
    .returning();
  await db.insert(creditAccountLedgerTable).values({
    tenantId: owner,
    kind: "spend",
    purchasedDeltaMilli: -spent * 1000,
    rateKey: "video",
    refKind: "videoJob",
    refId: String(job!.id),
    idempotencyKey: `claims-test-spend-${job!.id}-${++seq}`,
  });
  return job!;
}

const claimJob = (job: { id: number; createdAt: Date }) => ({
  id: job.id,
  status: "succeeded",
  createdAt: job.createdAt,
  isSmartEditChild: false,
});

function claim(job: { id: number; createdAt: Date }, over: Partial<Parameters<typeof fileClaim>[0]> = {}) {
  return fileClaim({
    tenantId,
    job: claimJob(job),
    versionId: "v0",
    videoDurationSec: 20,
    category: "product_changed",
    startSec: 4,
    endSec: 9,
    note: "",
    ...over,
  });
}

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
  quotaTenant = (await createTenant()).tenantId;
  await db.update(tenantsTable).set({ billingMode: "credits" }).where(eq(tenantsTable.id, tenantId));
  await db.update(tenantsTable).set({ billingMode: "quota" }).where(eq(tenantsTable.id, quotaTenant));
  await setMeterMode("enforce");
});

beforeEach(async () => {
  invalidateCreditRateCache();
  for (const id of [tenantId, quotaTenant]) {
    await db.delete(aiErrorClaimsTable).where(eq(aiErrorClaimsTable.tenantId, id));
    await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, id));
    await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, id));
    await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, id));
  }
  await db.delete(aiErrorGuaranteeSettingsTable);
  await setGuaranteeSettings({ ...DEFAULT_GUARANTEE_SETTINGS, enabled: true });
  await grantCredits({ tenantId, credits: 10, kind: "purchase", idempotencyKey: `claims-seed-${++seq}` });
});

afterAll(async () => {
  await setMeterMode("shadow");
  await db.delete(aiErrorGuaranteeSettingsTable);
  for (const id of [tenantId, quotaTenant]) {
    await db.delete(aiErrorClaimsTable).where(eq(aiErrorClaimsTable.tenantId, id));
    await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, id));
    await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, id));
    await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, id));
    await deleteTenant(id);
  }
  await pool.end();
});

describe("refund math", () => {
  it("refunds the marked share of what the video cost", () => {
    expect(suggestRefundCredits(40, 4, 9, 20)).toBe(10);
    expect(suggestRefundCredits(40, 0, 30, 20)).toBe(40);
    expect(suggestRefundCredits(0, 0, 5, 20)).toBe(0);
  });

  it("validates settings", () => {
    expect(() => validateGuaranteeSettings({ ...DEFAULT_GUARANTEE_SETTINGS, claimWindowDays: 0 })).toThrow();
    expect(() => validateGuaranteeSettings({ ...DEFAULT_GUARANTEE_SETTINGS, autoApproveMaxPercent: 101 })).toThrow();
  });
});

describe("filing a claim", () => {
  it("is off until switched on", async () => {
    await setGuaranteeSettings({ ...DEFAULT_GUARANTEE_SETTINGS });
    const job = await paidVideo();
    expect((await claimEligibility(tenantId, claimJob(job))).eligible).toBe(false);
    await expect(claim(job)).rejects.toBeInstanceOf(ClaimError);
  });

  it("auto-approves a clear error on a small part and refunds into the video's receipt", async () => {
    const job = await paidVideo(40);
    const before = (await peekCreditBalance(tenantId)).total;
    const filed = await claim(job);
    expect(filed).toMatchObject({ status: "approved", autoApproved: true, creditsRefunded: 10 });
    expect((await peekCreditBalance(tenantId)).total).toBe(before + 10);
    const receipt = await getVideoJobCreditReceipt(tenantId, job.id);
    expect(receipt.net).toBe(30);
    expect(receipt.lines.find((l) => l.rateKey === "ai_error")?.refunded).toBe(10);
  });

  it("allows one claim per video", async () => {
    const job = await paidVideo();
    await claim(job);
    await expect(claim(job)).rejects.toMatchObject({ status: 409 });
  });

  it("sends 'other', big ranges and over-limit workspaces to a person", async () => {
    const other = await claim(await paidVideo(), { category: "other", note: "The music is wrong" });
    expect(other.status).toBe("pending");
    const big = await claim(await paidVideo(), { startSec: 0, endSec: 15 });
    expect(big.status).toBe("pending");
    await claim(await paidVideo());
    await claim(await paidVideo());
    const third = await claim(await paidVideo());
    expect(third.status).toBe("pending");
  });

  it("needs a note for 'other' and a real range", async () => {
    await expect(claim(await paidVideo(), { category: "other", note: "" })).rejects.toMatchObject({ code: "note_required" });
    await expect(claim(await paidVideo(), { startSec: 5, endSec: 5.2 })).rejects.toMatchObject({ code: "invalid_range" });
    await expect(claim(await paidVideo(), { endSec: 40 })).rejects.toMatchObject({ code: "invalid_range" });
  });

  it("closes after the claim window and for non-credit workspaces", async () => {
    const old = await paidVideo(40, tenantId, new Date(Date.now() - 8 * 86_400_000));
    expect((await claimEligibility(tenantId, claimJob(old))).eligible).toBe(false);
    const quotaJob = await paidVideo(40, quotaTenant);
    expect((await claimEligibility(quotaTenant, claimJob(quotaJob))).eligible).toBe(false);
  });

  it("refuses a video that cost nothing", async () => {
    const [job] = await db
      .insert(videoGenerationsTable)
      .values({ tenantId, engine: "slideshow", status: "succeeded" } as never)
      .returning();
    await expect(claim(job!)).rejects.toMatchObject({ code: "nothing_charged" });
  });
});

describe("admin decisions", () => {
  it("approves a pending claim with a chosen refund, capped at what the video cost", async () => {
    const job = await paidVideo(40);
    const pending = await claim(job, { category: "other", note: "Logo is missing" });
    await expect(
      decideClaim({ claimId: pending.id, approve: true, credits: 41, adminTenantId: quotaTenant }),
    ).rejects.toMatchObject({ code: "over_cap" });
    const approved = await decideClaim({ claimId: pending.id, approve: true, credits: 15, adminTenantId: quotaTenant });
    expect(approved).toMatchObject({ status: "approved", creditsRefunded: 15 });
    expect((await getVideoJobCreditReceipt(tenantId, job.id)).net).toBe(25);
    await expect(
      decideClaim({ claimId: pending.id, approve: true, adminTenantId: quotaTenant }),
    ).rejects.toMatchObject({ code: "decided" });
  });

  it("rejects only with a reason and refunds nothing", async () => {
    const pending = await claim(await paidVideo(), { category: "other", note: "Not what I wanted" });
    await expect(decideClaim({ claimId: pending.id, approve: false, adminTenantId: quotaTenant })).rejects.toMatchObject({
      code: "reason_required",
    });
    const before = (await peekCreditBalance(tenantId)).total;
    const rejected = await decideClaim({
      claimId: pending.id,
      approve: false,
      note: "A change of mind isn't an AI error",
      adminTenantId: quotaTenant,
    });
    expect(rejected.status).toBe("rejected");
    expect((await peekCreditBalance(tenantId)).total).toBe(before);
  });

  it("reports claims by category for prompt fixes", async () => {
    await claim(await paidVideo());
    await claim(await paidVideo(), { category: "garbled_text" });
    const report = await claimsReport();
    expect(report.byCategory.map((r) => r.category)).toEqual(
      expect.arrayContaining(["product_changed", "garbled_text"]),
    );
  });
});
