import { describe, expect, it } from "vitest";
import type { CreditAccountLedgerEntry, VideoGeneration } from "@workspace/db";
import { planVideoCreditSettlement } from "./videoCreditSettlement";
import { computeVideoCreditTotals } from "./videoCreditSpend";

const job = (id: number) => ({
  id, tenantId: 7, status: "succeeded", funding: "credits",
  options: { billingPolicyVersion: 2, meterFunding: { tenantId: 7, rail: "credits", mode: "enforce" } },
}) as VideoGeneration;
const item = (owner: number, scene: string) => ({
  operationIdentity: `video-chain:1:storyboard_scene:${scene}:job:${owner}`,
  kind: "video_event", independentlySettled: false, unmetered: false, providerReservationId: null,
});
const spend = (id: number, owner: number, scene: string, amount: number) => ({
  id, tenantId: 7, kind: "spend", purchasedDeltaMilli: -amount, grantedDeltaMilli: 0,
  refKind: "videoJob", refId: String(owner), rateKey: "video_hd",
  idempotencyKey: `spend-family:videoJob:${owner}:clip-storyboard-render:storyboard_scene:${scene}:attempt:1`,
}) as CreditAccountLedgerEntry;
const apply = (ledger: CreditAccountLedgerEntry[], moves: ReturnType<typeof planVideoCreditSettlement>) =>
  [...ledger, ...moves.map((move, index) => ({
    ...move, id: 100 + ledger.length + index, kind: move.action,
    purchasedDeltaMilli: move.action === "spend" ? -move.creditsMilli : move.creditsMilli,
    grantedDeltaMilli: 0, balanceAfterMilli: 0, createdAt: new Date(0),
  }) as CreditAccountLedgerEntry)];

describe("Guided delivered credit accounting without provider calls or global settings", () => {
  it("accepts an explicit saved zero-price receipt, not a missing debit", () => {
    const items = [item(1, "s1")];
    const ledger = [spend(1, 1, "s1", 0)];
    expect(planVideoCreditSettlement(job(1), items, ledger)).toEqual([]);
    expect(computeVideoCreditTotals([job(1)], [{ jobId: 1, tenantId: 7, items }], ledger).get(1)).toBe(0);
  });
  it("does not race an outstanding meter refund", () => {
    const paid = spend(1, 1, "s1", 20_000);
    const pending = {
      ...paid, id: 2, kind: "refund_pending", purchasedDeltaMilli: 0,
      idempotencyKey: `${paid.idempotencyKey!.replace(/^spend/, "refund")}:pending`,
    };
    expect(() => planVideoCreditSettlement(job(1), null, [paid, pending]))
      .toThrow("refund is still pending");
  });
  it("keeps exact 720p scene debits and refuses a partial total", () => {
    const ledger = [spend(1, 1, "s1", 20_000), spend(2, 1, "s2", 32_000)];
    const items = [item(1, "s1"), item(1, "s2")];
    expect(planVideoCreditSettlement(job(1), items, ledger)).toEqual([]);
    expect(computeVideoCreditTotals([job(1)], [{ jobId: 1, tenantId: 7, items }], ledger).get(1)).toBe(52);
    expect(computeVideoCreditTotals([job(1)], [{ jobId: 1, tenantId: 7, items }], ledger.slice(0, 1)).get(1)).toBeNull();
    expect(() => planVideoCreditSettlement(job(1), items, ledger.slice(0, 1))).toThrow("no saved credit debit");
  });
  it("refunds failed work, charges only inherited delivered scenes at their original amount, and is idempotent", () => {
    let ledger = [spend(1, 1, "s1", 20_000), spend(2, 1, "discard", 32_000)];
    ledger = apply(ledger, planVideoCreditSettlement(job(1), null, ledger));
    expect(ledger.reduce((n, row) => n + row.purchasedDeltaMilli, 0)).toBe(0);
    expect(planVideoCreditSettlement(job(1), null, ledger)).toEqual([]);
    ledger.push(spend(3, 2, "s2", 12_000));
    const items = [item(1, "s1"), item(2, "s2")];
    const moves = planVideoCreditSettlement(job(2), items, ledger);
    expect(moves).toHaveLength(1);
    expect(moves[0].creditsMilli).toBe(20_000);
    ledger = apply(ledger, moves);
    expect(planVideoCreditSettlement(job(2), items, ledger)).toEqual([]);
    expect(planVideoCreditSettlement(job(3), items, ledger)).toEqual([]);
    expect(computeVideoCreditTotals([job(2)], [{ jobId: 2, tenantId: 7, items }], ledger).get(2)).toBe(32);
  });
  it("refunds discarded current scenes but not independently settled accepted inputs", () => {
    const accepted = { ...spend(4, 4, "portrait", 5000), refKind: "guidedPortrait", rateKey: "image" };
    const ledger = [spend(1, 4, "keep", 20_000), spend(2, 4, "discard", 32_000), accepted];
    const moves = planVideoCreditSettlement(job(4), [item(4, "keep")], ledger);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ action: "refund", creditsMilli: 32_000 });
    expect(planVideoCreditSettlement(job(4), null, [accepted])).toEqual([]);
  });
});
