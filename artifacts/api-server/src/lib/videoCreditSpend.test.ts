import { describe, expect, it } from "vitest";
import type {
  CreditAccountLedgerEntry,
  VideoGeneration,
} from "@workspace/db";
import { computeVideoCreditTotals } from "./videoCreditSpend";

function job(
  id: number,
  tenantId: number,
  overrides: Partial<VideoGeneration> = {},
): VideoGeneration {
  return {
    id,
    tenantId,
    status: "succeeded",
    options: {
      billingPolicyVersion: 2,
      meterFunding: {
        tenantId,
        rail: "credits",
        mode: "enforce",
      },
    },
    ...overrides,
  } as VideoGeneration;
}

function row(input: {
  tenantId: number;
  kind: string;
  purchased?: number;
  granted?: number;
  refId?: string;
  refKind?: string;
  key?: string;
  note?: string;
}): CreditAccountLedgerEntry {
  return {
    id: Number(`${input.tenantId}${Math.abs(input.purchased ?? input.granted ?? 0)}${input.kind.length}`),
    tenantId: input.tenantId,
    kind: input.kind,
    purchasedDeltaMilli: input.purchased ?? 0,
    grantedDeltaMilli: input.granted ?? 0,
    balanceAfterMilli: 0,
    rateKey: null,
    refKind: input.refKind ?? (input.refId ? "videoJob" : null),
    refId: input.refId ?? null,
    idempotencyKey: input.key ?? null,
    note: input.note ?? null,
    createdAt: new Date(0),
  };
}

const videoItem = {
  operationIdentity: "video-op",
  kind: "video_event",
  independentlySettled: false,
  providerReservationId: null,
  unmetered: false,
};

describe("computeVideoCreditTotals", () => {
  it("adds delivered video and accepted input debits across credit buckets", () => {
    const current = job(41, 7);
    const total = computeVideoCreditTotals(
      [current],
      [{
        jobId: 41,
        tenantId: 7,
        items: [
          videoItem,
          {
            operationIdentity: "guided-script:9:2",
            independentlySettled: true,
            providerReservationId: null,
            unmetered: false,
          },
          {
            operationIdentity: "guided-portrait:22",
            independentlySettled: true,
            providerReservationId: null,
            unmetered: false,
          },
        ],
      }],
      [
        row({ tenantId: 7, kind: "spend", granted: -2_250, refId: "41" }),
        row({
          tenantId: 7,
          kind: "spend",
          purchased: -500,
          key: "spend:guided-script:9:2:caption:attempt:1",
        }),
        row({
          tenantId: 7,
          kind: "spend",
          purchased: -1_000,
          key: "spend:guided-portrait:22:image:attempt:1",
        }),
      ],
    );
    expect(total.get(41)).toBe(3.75);
  });

  it("nets refunds and does not double-count retry or duplicate lifecycle rows", () => {
    const current = job(42, 7);
    const total = computeVideoCreditTotals(
      [current],
      [{ jobId: 42, tenantId: 7, items: [videoItem] }],
      [
        row({ tenantId: 7, kind: "spend", granted: -2_000, refId: "42" }),
        row({ tenantId: 7, kind: "refund", granted: 2_000, refId: "42" }),
        row({ tenantId: 7, kind: "meter_dispatch_failed", refId: "42" }),
        row({ tenantId: 7, kind: "spend", purchased: -1_250, refId: "42" }),
        row({ tenantId: 7, kind: "meter_dispatch_succeeded", refId: "42" }),
      ],
    );
    expect(total.get(42)).toBe(1.25);
  });

  it("includes a reused source operation once by frozen operation identity", () => {
    const current = job(46, 7);
    const total = computeVideoCreditTotals(
      [current],
      [{
        jobId: 46,
        tenantId: 7,
        items: [{
          operationIdentity: "video-job:12:scene:hero",
          independentlySettled: false,
          providerReservationId: null,
          unmetered: false,
        }],
      }],
      [
        row({
          tenantId: 7,
          kind: "spend",
          granted: -1_500,
          refId: "12",
          key: "spend:video-job:12:scene:hero:video:attempt:1",
        }),
        // The same row can match both lineage identity and a ref; filtering
        // ledger rows (rather than concatenating match sets) counts it once.
      ],
    );
    expect(total.get(46)).toBe(1.5);
  });

  it("returns null rather than a partial total when reused lineage is missing", () => {
    const current = job(48, 7);
    const total = computeVideoCreditTotals(
      [current],
      [{
        jobId: 48,
        tenantId: 7,
        items: [
          {
            operationIdentity: "video-job:12:scene:hero",
            independentlySettled: false,
            providerReservationId: null,
            unmetered: false,
          },
          {
            operationIdentity: "video-job:48:scene:new",
            independentlySettled: false,
            providerReservationId: null,
            unmetered: false,
          },
        ],
      }],
      [row({ tenantId: 7, kind: "spend", granted: -700, refId: "48" })],
    );
    expect(total.get(48)).toBeNull();
  });

  it("treats a refund-pending marker as resolved once its refund exists", () => {
    const current = job(47, 7);
    const refundKey = "spend:video-job:47:video:attempt:1:settle-refund";
    const total = computeVideoCreditTotals(
      [current],
      [{ jobId: 47, tenantId: 7, items: [videoItem] }],
      [
        row({ tenantId: 7, kind: "spend", granted: -2_000, refId: "47" }),
        row({
          tenantId: 7,
          kind: "refund_pending",
          refId: "47",
          key: `${refundKey}:pending`,
          note: JSON.stringify({ refundKey }),
        }),
        row({
          tenantId: 7,
          kind: "refund",
          granted: 500,
          refId: "47",
          key: refundKey,
        }),
      ],
    );
    expect(total.get(47)).toBe(1.5);
  });

  it("returns null for historical or incomplete attribution, never invented zero", () => {
    const historical = job(43, 7, { options: null });
    const incomplete = job(44, 7);
    const totals = computeVideoCreditTotals(
      [historical, incomplete],
      [{ jobId: 44, tenantId: 7, items: [videoItem] }],
      [],
    );
    expect(totals.get(43)).toBeNull();
    expect(totals.get(44)).toBeNull();
  });

  it("attributes the frozen production Guided role identities to their real debit families", () => {
    const current = job(15, 7, {
      options: {
        billingPolicyVersion: 2,
        meterFunding: { tenantId: 7, rail: "credits", mode: "enforce" },
        guidedStory: { draftId: 7, draftRevision: 4 },
      } as VideoGeneration["options"],
    });
    const totals = computeVideoCreditTotals(
      [current],
      [{
        jobId: 15,
        tenantId: 7,
        items: [
          {
            operationIdentity: "guided-portrait:ravi",
            kind: "portrait",
            independentlySettled: false,
            providerReservationId: null,
            unmetered: false,
          },
          {
            operationIdentity: "guided-sheet:ravi",
            kind: "reference_sheet",
            independentlySettled: false,
            providerReservationId: null,
            unmetered: false,
          },
          {
            operationIdentity: "video-chain:14:topic_scene:s4:job:15",
            kind: "video_event",
            independentlySettled: false,
            providerReservationId: null,
            unmetered: false,
          },
        ],
      }],
      [
        row({
          tenantId: 7,
          kind: "spend",
          purchased: -5_000,
          refKind: "guidedStoryCast",
          refId: "7:4:ravi",
          key: "spend-family:guided-story-cast:7:4:ravi:attempt:1",
        }),
        row({
          tenantId: 7,
          kind: "spend",
          purchased: -5_000,
          refKind: "character",
          refId: "15",
          key: "spend-family:guided-story-sheet:7:4:ravi",
        }),
        row({
          tenantId: 7,
          kind: "provider_debit",
          granted: -2_250,
          refId: "15",
          key: "spend:videoJob:15:topic_scene:s4:video",
        }),
      ],
    );
    expect(totals.get(15)).toBe(12.25);
  });

  it("uses future accepted-input operation linkage and fails closed for unknown paid inputs", () => {
    const current = job(51, 7);
    const baseItems = [{
      operationIdentity: "video-chain:51:topic_scene:s1:job:51",
      kind: "video_event",
      independentlySettled: false,
      providerReservationId: null,
      unmetered: false,
    }];
    const linked = {
      operationIdentity: "guided-story-cast:12:3:hero",
      kind: "portrait",
      independentlySettled: true,
      providerReservationId: null,
      unmetered: false,
    };
    const ledger = [
      row({
        tenantId: 7,
        kind: "spend",
        purchased: -1_000,
        key: "spend-family:guided-story-cast:12:3:hero:attempt:1",
      }),
      row({
        tenantId: 7,
        kind: "spend",
        purchased: -2_000,
        refId: "51",
        key: "spend:videoJob:51:topic_scene:s1:video",
      }),
    ];
    expect(computeVideoCreditTotals(
      [current],
      [{ jobId: 51, tenantId: 7, items: [...baseItems, linked] }],
      ledger,
    ).get(51)).toBe(3);

    const unknownBackdrop = {
      ...linked,
      operationIdentity: "guided-backdrop-unknown:sha256",
      kind: "backdrop",
    };
    expect(computeVideoCreditTotals(
      [current],
      [{ jobId: 51, tenantId: 7, items: [...baseItems, linked, unknownBackdrop] }],
      ledger,
    ).get(51)).toBeNull();
  });

  it("fails closed during pending refunds and isolates tenants", () => {
    const current = job(45, 7);
    const pending = computeVideoCreditTotals(
      [current],
      [{ jobId: 45, tenantId: 7, items: [videoItem] }],
      [
        row({ tenantId: 8, kind: "spend", granted: -9_000, refId: "45" }),
        row({ tenantId: 7, kind: "spend", granted: -2_000, refId: "45" }),
        row({ tenantId: 7, kind: "refund_pending", refId: "45" }),
      ],
    );
    expect(pending.get(45)).toBeNull();

    const isolated = computeVideoCreditTotals(
      [current],
      [{ jobId: 45, tenantId: 7, items: [videoItem] }],
      [row({ tenantId: 8, kind: "spend", granted: -9_000, refId: "45" })],
    );
    expect(isolated.get(45)).toBeNull();
  });
});