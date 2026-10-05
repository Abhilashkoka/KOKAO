import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, creditAccountLedgerTable, creditMeterEventsTable, creditAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../../../test/dbHelpers";

vi.mock("../../creditRates", async (original) => ({
  ...await original<typeof import("../../creditRates")>(),
  getMeterMode: vi.fn(async () => { throw new Error("Do not reselect accepted funding"); }),
  creditCostSnapshotFor: vi.fn(async (key: string, quantity: number) => ({
    unitRateMilli: key === "video_hd" ? 4000 : 2000,
    costMilli: Math.round(quantity * (key === "video_hd" ? 4000 : 2000)),
    active: true, valid: true,
  })),
}));
vi.mock("../types", async (original) => ({
  ...await original<typeof import("../types")>(),
  videoGenFetch: vi.fn(async (_url: string, init: RequestInit) =>
    init.method === "POST"
      ? new Response(JSON.stringify({ id: "isolated-request", status: "completed", video: { url: "https://example.com/video.mp4" } }))
      : new Response(new Uint8Array([1, 2, 3]))),
}));
vi.mock("../../webFetch", () => ({ assertPublicHost: vi.fn(async () => {}) }));

import { generateWithHiggsfield } from "./higgsfield";
import { grantCredits, getCreditBalance } from "../../creditAccounts";
import { meter } from "../../meter";
import { videoGenFetch } from "../types";
import { settleVideoCredits } from "../../videoCreditSettlement";
import { computeVideoCreditTotals } from "../../videoCreditSpend";
import type { VideoGeneration } from "@workspace/db";
let tenantId: number;
beforeAll(async () => {
  tenantId = (await createTenant({ plan: "pro" })).tenantId;
  await grantCredits({ tenantId, credits: 100, kind: "purchase" });
});
afterAll(async () => {
  await db.delete(creditMeterEventsTable).where(eq(creditMeterEventsTable.tenantId, tenantId));
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
});
describe("Guided Higgsfield adapter with real account ledger and isolated saved rates", () => {
  it("charges each resolution-aware scene once, prevents replay dispatch, and leaves QA free", async () => {
    for (const [index, resolution] of ["480p", "720p"].entries()) {
      const input = {
        prompt: "Approved scene", aspectRatio: "9:16" as const, durationSec: 5,
        model: "seedance/text-to-video", resolution,
        meterContext: {
          tenantId, refKind: "videoJob", refId: "1",
          operationKey: `videoJob:1:storyboard_scene:${index}`,
          funding: { tenantId, rail: "credits" as const, mode: "enforce" as const },
        },
      };
      await generateWithHiggsfield(input, "isolated-key");
      const calls = vi.mocked(videoGenFetch).mock.calls.length;
      await expect(generateWithHiggsfield(input, "isolated-key")).rejects.toThrow();
      expect(vi.mocked(videoGenFetch).mock.calls.length).toBe(calls);
    }
    await meter({
      tenantId, refKind: "videoInternalQa", refId: "isolated-guided",
      operationKey: "qa", funding: { tenantId, rail: "quota", mode: "shadow" },
    }, "transcription", 5, async () => "verified");
    const ledger = await db.select().from(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
    expect(ledger.filter(row => row.kind === "spend").map(row => row.purchasedDeltaMilli)).toEqual([-10_000, -20_000]);
    expect((await getCreditBalance(tenantId)).total).toBe(70);
    const source = {
      id: 1, tenantId, funding: "credits", status: "failed",
      options: {
        guidedStory: {}, billingPolicyVersion: 2,
        meterFunding: { tenantId, rail: "credits", mode: "enforce" },
      },
    } as VideoGeneration;
    await db.transaction(tx => settleVideoCredits(tx, source, null));
    expect((await getCreditBalance(tenantId)).total).toBe(100);
    await db.transaction(tx => settleVideoCredits(tx, source, null));
    expect((await getCreditBalance(tenantId)).total).toBe(100);
    const child = { ...source, id: 2, status: "succeeded" };
    const items = [{
      operationIdentity: "video-chain:1:storyboard_scene:1:job:1",
      kind: "video_event", independentlySettled: false,
      unmetered: false, providerReservationId: null,
    }];
    await db.transaction(tx => settleVideoCredits(tx, child, items));
    await db.transaction(tx => settleVideoCredits(tx, child, items));
    expect((await getCreditBalance(tenantId)).total).toBe(80);
    const settled = await db.select().from(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
    expect(computeVideoCreditTotals([child], [{ jobId: 2, tenantId, items }], settled).get(2)).toBe(20);
  });
});
