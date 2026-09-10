import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  pool,
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  topUpCreditAccount,
  getCreditBalance,
  grantCredits,
} from "./creditAccounts";
import { setMeterMode, upsertCreditRate, invalidateCreditRateCache } from "./creditRates";
import { refuseIfShortOfCredits, respondToCreditError } from "./creditPreflight";
import { InsufficientCreditsError } from "./creditAccounts";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

/** A minimal Express Response double: enough to capture status + body. */
function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as never, captured };
}

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
});

afterAll(async () => {
  await setMeterMode("shadow");
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  invalidateCreditRateCache();
});

describe("credit pack top-ups", () => {
  const pack = { id: 7, name: "Regular", credits: 350 };

  it("credits the balance into the never-expiring bucket", async () => {
    await topUpCreditAccount(tenantId, pack, "rzp:order_abc");
    const balance = await getCreditBalance(tenantId);
    expect(balance.purchased).toBe(350);
    expect(balance.granted).toBe(0);
    expect(balance.grantedExpiresAt).toBeNull();
  });

  it("credits exactly once when the verify route and the webhook both fire", async () => {
    // Both paths use the same gateway order key. In production they race on
    // every purchase; whichever lands first credits and the other is a no-op.
    await topUpCreditAccount(tenantId, pack, "rzp:order_abc");
    await topUpCreditAccount(tenantId, pack, "rzp:order_abc");
    expect((await getCreditBalance(tenantId)).total).toBe(350);
  });

  it("treats a different order as a separate purchase", async () => {
    await topUpCreditAccount(tenantId, pack, "rzp:order_abc");
    await topUpCreditAccount(tenantId, pack, "rzp:order_def");
    expect((await getCreditBalance(tenantId)).total).toBe(700);
  });

  it("is a no-op for a legacy pack that carries no balance credits", async () => {
    await topUpCreditAccount(tenantId, { id: 8, name: "Legacy", credits: 0 }, "rzp:order_xyz");
    expect((await getCreditBalance(tenantId)).total).toBe(0);
  });
});

describe("credit preflight", () => {
  beforeEach(async () => {
    await upsertCreditRate({ key: "video", label: "Video", unit: "second", credits: 1, active: true });
    await upsertCreditRate({ key: "image", label: "Image", unit: "item", credits: 3, active: true });
    await upsertCreditRate({ key: "caption", label: "Caption", unit: "item", credits: 0, active: true });
  });

  it("allows everything through while the meter is not enforcing", async () => {
    await setMeterMode("shadow");
    const { res, captured } = fakeRes();
    expect(
      await refuseIfShortOfCredits(res, tenantId, { durationSec: 60, sceneCount: 4 }),
    ).toBe(false);
    expect(captured.status).toBeUndefined();
  });

  it("refuses a job the balance cannot cover, with the figures", async () => {
    await setMeterMode("enforce");
    await grantCredits({ tenantId, credits: 5, kind: "purchase" });
    const { res, captured } = fakeRes();

    // 20s of video + 4 keyframes = 32 credits against a balance of 5.
    expect(
      await refuseIfShortOfCredits(res, tenantId, { durationSec: 20, sceneCount: 4 }),
    ).toBe(true);
    expect(captured.status).toBe(402);
    expect(captured.body).toMatchObject({
      code: "insufficient_credits",
      required: 32,
      available: 5,
      shortfall: 27,
    });
  });

  it("lets a job through when the balance covers it", async () => {
    await setMeterMode("enforce");
    await grantCredits({ tenantId, credits: 100, kind: "purchase" });
    const { res, captured } = fakeRes();
    expect(
      await refuseIfShortOfCredits(res, tenantId, { durationSec: 20, sceneCount: 4 }),
    ).toBe(false);
    expect(captured.status).toBeUndefined();
  });

  it("maps a mid-flight refusal to the same 402 shape", async () => {
    const { res, captured } = fakeRes();
    expect(respondToCreditError(res, new InsufficientCreditsError(45_000, 12_000))).toBe(true);
    expect(captured.status).toBe(402);
    expect(captured.body).toMatchObject({
      code: "insufficient_credits",
      required: 45,
      available: 12,
      shortfall: 33,
    });
  });

  it("ignores errors that are not about credits", () => {
    const { res, captured } = fakeRes();
    expect(respondToCreditError(res, new Error("provider down"))).toBe(false);
    expect(captured.status).toBeUndefined();
  });
});
