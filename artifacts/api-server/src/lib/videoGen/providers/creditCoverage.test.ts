import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real unified meter, without importing a database connection or
// changing any saved rates. Values represent the saved-price fixture in credits.
const mocks = vi.hoisted(() => ({
  events: vi.fn(async (_row: unknown) => {}),
  spend: vi.fn(async (input: { idempotencyKey: string; refundIdempotencyKey: string }) => ({
    applied: true,
    idempotencyKey: input.idempotencyKey,
    refundIdempotencyKey: input.refundIdempotencyKey,
  })),
  price: vi.fn(async (key: string, quantity: number) => {
    const rates: Record<string, number> = { video_hd: 4000, image: 5000, transcription: 50 };
    if (!(key in rates)) throw new Error(`Unexpected price key: ${key}`);
    return { unitRateMilli: rates[key], costMilli: Math.round(quantity * rates[key]), active: true, valid: true };
  }),
  mode: vi.fn(async () => { throw new Error("Frozen funding must not reread global mode"); }),
}));

vi.mock("@workspace/db", () => ({
  db: { insert: () => ({ values: mocks.events }) },
  creditMeterEventsTable: {},
}));
vi.mock("../../logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../../creditRates", () => ({
  MILLI: 1000,
  creditCostSnapshotFor: mocks.price,
  getMeterMode: mocks.mode,
  listCreditRates: vi.fn(),
}));
vi.mock("../../creditAccounts", () => ({
  spendCreditsOnce: mocks.spend,
  refundCredits: vi.fn(),
  queueCreditMeterRefund: vi.fn(),
  markCreditMeterDispatchStarted: vi.fn(),
  markCreditMeterDispatchOutcome: vi.fn(),
  markCreditMeterDispatchFailedWithRefund: vi.fn(),
  recoverCreditMeterBeforeReplay: vi.fn(),
  InsufficientCreditsError: class extends Error {},
}));

import { meter, type MeterFundingSnapshot } from "../../meter";

describe("newvideo saved-price credit coverage (isolated)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("charges scene seconds, four images, fractional ASR and one backdrop: 97.724 credits", async () => {
    const funding: MeterFundingSnapshot = Object.freeze({ tenantId: 42, rail: "credits", mode: "enforce" });
    const operation = (operationKey: string) => ({
      tenantId: 42, funding, operationKey, refKind: "video", refId: "test-video",
    });
    // Three scenes totaling 18 seconds, not 18 seconds for each scene.
    for (const [index, seconds] of [5, 5, 8].entries()) {
      await meter(operation(`scene:${index}`), "video_hd", seconds, async () => "clip");
    }
    for (let index = 0; index < 4; index++) {
      await meter(operation(`keyframe:${index}`), "image", 1, async () => "image");
    }
    await meter(operation("asr"), "transcription", 14.475, async () => "transcript");
    await meter(operation("backdrop"), "image", 1, async () => "backdrop");

    const charges = mocks.spend.mock.calls.map(([input]) => input as unknown as { rateKey: string; creditsMilli: number });
    expect(charges.filter(c => c.rateKey === "video_hd").reduce((n, c) => n + c.creditsMilli, 0)).toBe(72000);
    expect(charges.slice(3, 7).reduce((n, c) => n + c.creditsMilli, 0)).toBe(20000);
    expect(charges[7].creditsMilli).toBe(724);
    expect(charges[8].creditsMilli).toBe(5000);
    expect(charges.reduce((n, c) => n + c.creditsMilli, 0)).toBe(97724);
    expect(mocks.price).toHaveBeenCalledWith("transcription", 14.475);
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(mocks.events).toHaveBeenCalledTimes(9);
  });

  it("keeps explicitly unmetered QA a no-charge pass-through", async () => {
    const qa = vi.fn(async () => "approved");
    await expect(meter(null, "image", 1, qa)).resolves.toBe("approved");
    expect(qa).toHaveBeenCalledOnce();
    expect(mocks.price).not.toHaveBeenCalled();
    expect(mocks.spend).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.mode).not.toHaveBeenCalled();
  });
});