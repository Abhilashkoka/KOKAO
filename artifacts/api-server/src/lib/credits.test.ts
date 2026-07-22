import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  getCreditBalances,
  spendCredit,
  refundCredits,
  grantCredits,
  listCreditHistory,
} from "./credits";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
});

afterAll(async () => {
  await deleteTenant(tenantId);
  await pool.end();
});

describe("credits lib", () => {
  it("starts at zero and refuses to spend from an empty balance", async () => {
    expect(await getCreditBalances(tenantId)).toEqual({
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 0,
    });
    expect(await spendCredit(tenantId, "caption")).toBe(false);
    expect(await spendCredit(tenantId, "image")).toBe(false);
    expect(await spendCredit(tenantId, "video")).toBe(false);
  });

  it("grants, spends, and records ledger entries", async () => {
    expect(
      await grantCredits({
        tenantId,
        captionCredits: 2,
        imageCredits: 1,
        kind: "admin_grant",
        note: "test grant",
      }),
    ).toBe(true);
    expect(await getCreditBalances(tenantId)).toEqual({
      captionCredits: 2,
      imageCredits: 1,
      videoCredits: 0,
    });

    expect(await spendCredit(tenantId, "caption")).toBe(true);
    expect(await spendCredit(tenantId, "image")).toBe(true);
    expect(await spendCredit(tenantId, "image")).toBe(false);
    expect(await getCreditBalances(tenantId)).toEqual({
      captionCredits: 1,
      imageCredits: 0,
      videoCredits: 0,
    });

    const history = await listCreditHistory(tenantId);
    expect(history.length).toBe(3);
    expect(history.filter((h) => h.kind === "spend").length).toBe(2);
    expect(history.filter((h) => h.kind === "admin_grant").length).toBe(1);
  });

  it("is idempotent per Razorpay order id", async () => {
    const orderId = `order_test_${Date.now()}`;
    expect(
      await grantCredits({
        tenantId,
        captionCredits: 5,
        imageCredits: 5,
        kind: "purchase",
        razorpayOrderId: orderId,
      }),
    ).toBe(true);
    // Second grant for the same order must be a no-op.
    expect(
      await grantCredits({
        tenantId,
        captionCredits: 5,
        imageCredits: 5,
        kind: "purchase",
        razorpayOrderId: orderId,
      }),
    ).toBe(false);
    const balances = await getCreditBalances(tenantId);
    expect(balances.captionCredits).toBe(6); // 1 left over + 5, not +10
    expect(balances.imageCredits).toBe(5);
  });

  it("clamps negative grants at zero and keeps the ledger reconcilable", async () => {
    // Balance is 6 captions / 5 images. Deduct more than exists.
    expect(
      await grantCredits({
        tenantId,
        captionCredits: -100,
        imageCredits: -2,
        kind: "admin_grant",
        note: "deduction",
      }),
    ).toBe(true);
    expect(await getCreditBalances(tenantId)).toEqual({
      captionCredits: 0,
      imageCredits: 3,
      videoCredits: 0,
    });
    // The ledger records the APPLIED delta, so summing all deltas
    // reproduces the stored balance exactly.
    const history = await listCreditHistory(tenantId, 100);
    const captionSum = history.reduce((s, h) => s + h.captionDelta, 0);
    const imageSum = history.reduce((s, h) => s + h.imageDelta, 0);
    expect(captionSum).toBe(0);
    expect(imageSum).toBe(3);
    const deduction = history.find((h) => h.note === "deduction");
    expect(deduction?.captionDelta).toBe(-6);
    expect(deduction?.imageDelta).toBe(-2);
  });

  it("multi-count spend is all-or-nothing and refunds restore the balance", async () => {
    // Balance is 0 captions / 3 images after the previous test.
    expect(await spendCredit(tenantId, "image", 4)).toBe(false); // insufficient
    expect(await getCreditBalances(tenantId)).toMatchObject({ imageCredits: 3 });

    expect(await spendCredit(tenantId, "image", 3)).toBe(true);
    expect(await getCreditBalances(tenantId)).toMatchObject({ imageCredits: 0 });

    // Refund returns the reserved credits with an audited ledger entry.
    await refundCredits(tenantId, "image", 3, "generation failed");
    expect(await getCreditBalances(tenantId)).toMatchObject({ imageCredits: 3 });
    const history = await listCreditHistory(tenantId, 100);
    const refund = history.find((h) => h.kind === "refund");
    expect(refund?.imageDelta).toBe(3);
    // Ledger still reconciles with the stored balance.
    const imageSum = history.reduce((s, h) => s + h.imageDelta, 0);
    expect(imageSum).toBe(3);
  });

  it("video credits are a separate spendable kind with their own ledger column", async () => {
    expect(
      await grantCredits({
        tenantId,
        captionCredits: 0,
        imageCredits: 0,
        videoCredits: 2,
        kind: "admin_grant",
        note: "video grant",
      }),
    ).toBe(true);
    expect((await getCreditBalances(tenantId)).videoCredits).toBe(2);

    // Spending video credits never touches the other balances.
    const before = await getCreditBalances(tenantId);
    expect(await spendCredit(tenantId, "video")).toBe(true);
    const after = await getCreditBalances(tenantId);
    expect(after.videoCredits).toBe(1);
    expect(after.captionCredits).toBe(before.captionCredits);
    expect(after.imageCredits).toBe(before.imageCredits);

    await refundCredits(tenantId, "video", 1, "video generation failed");
    expect((await getCreditBalances(tenantId)).videoCredits).toBe(2);

    const history = await listCreditHistory(tenantId, 100);
    const videoSum = history.reduce((s, h) => s + h.videoDelta, 0);
    expect(videoSum).toBe(2);
  });
});
