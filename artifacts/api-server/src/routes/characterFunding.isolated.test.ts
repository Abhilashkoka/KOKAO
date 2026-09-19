import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { transformSync } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Execute the real route funding functions without importing the Express
// application (whose integration bootstrap can mutate shared billing settings).
// All persistence/provider dependencies are explicit in-memory test doubles.
const source = readFileSync(new URL("./characters.ts", import.meta.url), "utf8");
const functions = transformSync(
  source.slice(source.indexOf("export interface ImageFunding"), source.indexOf("function imageErrorStatus")),
  { loader: "ts", format: "cjs" },
).code;
const state = {
  freezeMeterFunding: vi.fn(),
  isWalletFunded: vi.fn(),
  reserveWallet: vi.fn(),
  getPlanLimits: vi.fn(),
  getUsage: vi.fn(),
  spendCredit: vi.fn(),
  refundCredits: vi.fn(),
  refundWallet: vi.fn(),
  recordUsage: vi.fn(),
  settleWalletProviderOperationDurably: vi.fn(),
};
const db = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ id: 7, plan: "free" }] }),
    }),
  }),
};
const api = new Function(
  "module", "db", "tenantsTable", "eq", "randomUUID", ...Object.keys(state),
  `${functions}; return { reserveImageFunding, settleImageFunding, releaseImageFunding, characterImageOperationKey };`,
)({ exports: {} }, db, { id: "id" }, () => true, randomUUID, ...Object.values(state));
const req = { tenantId: 7, log: { error: vi.fn() } };
const meta = { durationMs: 1, responseBytes: 5, model: "image-model", provider: "provider" };

beforeEach(() => {
  vi.resetAllMocks();
  state.freezeMeterFunding.mockResolvedValue(Object.freeze({ tenantId: 7, rail: "credits", mode: "enforce" }));
  state.isWalletFunded.mockResolvedValue(false);
  state.getPlanLimits.mockResolvedValue({ images: 0 });
  state.getUsage.mockResolvedValue({ images: 99 });
  state.recordUsage.mockResolvedValue(undefined);
  state.refundCredits.mockResolvedValue(undefined);
  state.refundWallet.mockResolvedValue(undefined);
  state.settleWalletProviderOperationDurably.mockResolvedValue(undefined);
});

describe("new character image funding (isolated, no database)", () => {
  it("selects enforced credits before any legacy quota, wallet, or credit access", async () => {
    state.isWalletFunded.mockResolvedValue(true);
    const funding = await api.reserveImageFunding(req);
    expect(funding.source).toBe("credits");
    expect(funding.meterFunding).toEqual({ tenantId: 7, rail: "credits", mode: "enforce" });
    expect(Object.isFrozen(funding.meterFunding)).toBe(true);
    for (const key of ["isWalletFunded", "reserveWallet", "getUsage", "getPlanLimits", "spendCredit"] as const) {
      expect(state[key]).not.toHaveBeenCalled();
    }
  });

  it("leaves credits debit/settlement/refund to the provider meter, recording usage only", async () => {
    const funding = await api.reserveImageFunding(req);
    await api.settleImageFunding(req, funding, meta);
    await api.releaseImageFunding(req, funding);
    expect(state.recordUsage).toHaveBeenCalledWith(7, "image", expect.objectContaining({ funding: "credits" }));
    expect(state.refundCredits).not.toHaveBeenCalled();
    expect(state.refundWallet).not.toHaveBeenCalled();
    expect(state.settleWalletProviderOperationDurably).not.toHaveBeenCalled();
  });

  it("uses one stable identity within an action and different identities for new completed-action retries", async () => {
    const first = await api.reserveImageFunding(req);
    const second = await api.reserveImageFunding(req);
    for (const key of ["character-reference:7:Sam", "character-reference-sheet:8", "character-outfit:8:coat", "preset-outfit:stable"]) {
      expect(api.characterImageOperationKey(first, key)).toBe(api.characterImageOperationKey(first, key));
      expect(api.characterImageOperationKey(first, key)).not.toBe(api.characterImageOperationKey(second, key));
    }
  });

  it.each(["off", "shadow", "enforce"])("preserves the frozen legacy rail in %s mode", async (mode) => {
    state.freezeMeterFunding.mockResolvedValue(Object.freeze({ tenantId: 7, rail: "quota", mode }));
    state.getPlanLimits.mockResolvedValue({ images: -1 });
    const funding = await api.reserveImageFunding(req);
    expect(funding.source).toBe("quota");
    expect(funding.meterFunding.mode).toBe(mode);
    expect(api.characterImageOperationKey(funding, "old-operation")).toBe("old-operation");
    expect(state.spendCredit).not.toHaveBeenCalled();
  });

  it("preserves pinned wallet reservation, settlement, and failure refund", async () => {
    state.freezeMeterFunding.mockResolvedValue({ tenantId: 7, rail: "quota", mode: "enforce" });
    state.isWalletFunded.mockResolvedValue(true);
    const receipt = { id: 4, amountPaise: 100, units: 1 };
    const pinned = { provider: "pinned", model: "pinned-model" };
    state.reserveWallet.mockResolvedValue(receipt);
    const funding = await api.reserveImageFunding(req, pinned);
    expect(state.reserveWallet).toHaveBeenCalledWith(7, "image", pinned);
    expect(funding.meterFunding.rail).toBe("wallet");
    await api.settleImageFunding(req, funding, meta, 88);
    expect(state.settleWalletProviderOperationDurably).toHaveBeenCalledWith(88);
    await api.releaseImageFunding(req, funding);
    expect(state.refundWallet).toHaveBeenCalledWith(7, receipt, expect.any(String));
  });

  it("preserves insufficient legacy funding and legacy-credit refunds", async () => {
    state.freezeMeterFunding.mockResolvedValue({ tenantId: 7, rail: "quota", mode: "shadow" });
    state.spendCredit.mockResolvedValue(false);
    expect(await api.reserveImageFunding(req)).toBeNull();
    state.spendCredit.mockResolvedValue(true);
    const funding = await api.reserveImageFunding(req);
    expect(funding.source).toBe("credit");
    await api.releaseImageFunding(req, funding);
    expect(state.refundCredits).toHaveBeenCalledWith(7, "image", 1, expect.any(String));
  });
});

describe("queued flat/layered image funding compatibility", () => {
  it.each(["../lib/imageJobs.ts", "../lib/imageLayers/job.ts"])("%s restores only explicitly credits-funded jobs to enforcement", (path) => {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    const start = text.indexOf("function imageJobFunding(");
    const end = text.indexOf("\n}", start) + 2;
    const code = transformSync(text.slice(start, end), { loader: "ts" }).code;
    const restore = new Function(`${code}; return imageJobFunding;`)();
    expect(restore(7, "credits")).toEqual({ tenantId: 7, rail: "credits", mode: "enforce" });
    for (const rail of ["quota", "credit", "wallet"]) {
      expect(restore(7, rail)).toEqual({ tenantId: 7, rail, mode: "shadow" });
    }
  });
});

describe("reference-analysis funding", () => {
  const text = readFileSync(new URL("./videoStyles.ts", import.meta.url), "utf8");
  const block = text.slice(text.indexOf("interface Funding"), text.indexOf("async function releaseCaptionFunding"));
  const code = transformSync(block, { loader: "ts" }).code;
  const reserve = new Function(
    ...Object.keys(state),
    `${code}; return reserveCaptionFunding;`,
  )(...Object.values(state));

  it("authorizes enforced credits without spending a legacy caption", async () => {
    const funding = await reserve(7, "free");
    expect(funding).toEqual({ source: "credits", funding: { tenantId: 7, rail: "credits", mode: "enforce" } });
    expect(state.isWalletFunded).not.toHaveBeenCalled();
    expect(state.spendCredit).not.toHaveBeenCalled();
    expect(state.getUsage).not.toHaveBeenCalled();
  });

  it("preserves legacy caption quota when credits are not authorized", async () => {
    state.freezeMeterFunding.mockResolvedValue({ tenantId: 7, rail: "quota", mode: "shadow" });
    state.getPlanLimits.mockResolvedValue({ captions: -1 });
    state.getUsage.mockResolvedValue({ captions: 0 });
    expect((await reserve(7, "free")).source).toBe("quota");
  });
});