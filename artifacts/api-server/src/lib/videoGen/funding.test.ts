import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { videoFundingSnapshot } from "./funding";

const controls = vi.hoisted(() => ({
  mode: vi.fn(),
  eligible: vi.fn(),
}));
vi.mock("../creditRates", () => ({ getMeterMode: controls.mode }));
vi.mock("../creditAccounts", () => ({ isCreditFunded: controls.eligible }));
import { freezeMeterFunding } from "../meterFunding";

describe("video funding acceptance and durable recovery (no database)", () => {
  beforeEach(() => {
    controls.mode.mockReset().mockResolvedValue("enforce");
    controls.eligible.mockReset().mockResolvedValue(true);
  });

  it("selects the existing eligible credit account and survives queue serialization and mode changes", async () => {
    const snapshot = await freezeMeterFunding(17);
    expect(snapshot).toEqual({ tenantId: 17, rail: "credits", mode: "enforce" });
    expect(controls.eligible).toHaveBeenCalledWith(17, "enforce");
    const queued = JSON.parse(JSON.stringify({
      tenantId: 17, funding: "credits", options: { meterFunding: snapshot },
    }));
    controls.mode.mockResolvedValue("off");
    controls.eligible.mockResolvedValue(false);
    const recovered = videoFundingSnapshot(queued);
    expect(recovered).toEqual(snapshot);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(controls.mode).toHaveBeenCalledTimes(1);
    expect(controls.eligible).toHaveBeenCalledTimes(1);
  });

  it("does not authorize ineligible enforce tenants", async () => {
    controls.eligible.mockResolvedValue(false);
    expect((await freezeMeterFunding(17)).rail).toBe("quota");
  });

  it.each(["off", "shadow"])("does not migrate new %s work", async (mode) => {
    controls.mode.mockResolvedValue(mode);
    expect((await freezeMeterFunding(17)).rail).toBe("quota");
    expect(controls.eligible).not.toHaveBeenCalled();
  });

  it.each(["quota", "wallet", "credit", null] as const)(
    "keeps already queued historical %s jobs out of credit accounts",
    (funding) => {
      expect(videoFundingSnapshot({ tenantId: 17, funding })).toEqual({
        tenantId: 17, rail: funding ?? "quota", mode: "shadow",
      });
      expect(controls.mode).not.toHaveBeenCalled();
      expect(controls.eligible).not.toHaveBeenCalled();
    },
  );

  it("fails closed if a credits job lost its snapshot", () => {
    expect(() => videoFundingSnapshot({ tenantId: 17, funding: "credits" }))
      .toThrow("missing its frozen funding snapshot");
  });

  it.each([
    { tenantId: 18, rail: "credits", mode: "enforce" },
    { tenantId: 17, rail: "wallet", mode: "enforce" },
    { tenantId: 17, rail: "credits", mode: "shadow" },
  ] as const)("rejects inconsistent durable snapshot %j", (meterFunding) => {
    expect(() => videoFundingSnapshot({
      tenantId: 17, funding: "credits", options: { meterFunding },
    })).toThrow("does not match");
  });
});

describe("video pipeline funding wiring regressions", () => {
  const routes = readFileSync(new URL("../../routes/videos.ts", import.meta.url), "utf8");
  const runner = readFileSync(new URL("./jobRunner.ts", import.meta.url), "utf8");
  const narration = readFileSync(new URL("./topicVideo/narration.ts", import.meta.url), "utf8");

  it("persists the frozen decision on every new job creation rail", () => {
    expect(routes.match(/(?:options|childOptions)\.meterFunding = Object\.freeze/g)).toHaveLength(4);
    expect(routes).toContain('const funding: "quota" | "credit" | "wallet" | "credits" = creditSnapshot.rail === "credits"');
    expect(routes).toContain('const walletRetry = creditSnapshot.rail !== "credits"');
  });

  it("restores cast, sheet and backdrop checkpoint snapshots instead of relabeling credits legacy", () => {
    for (const checkpoint of ["operation", "sheetOperation", "checkpoint"]) {
      expect(routes).toContain(`options: { meterFunding: ${checkpoint}.meterFunding }`);
    }
    expect(routes).toContain("meterFunding: funding.meterFunding");
    expect(routes).toContain("meterFunding: sheetFunding.meterFunding");
  });

  it("prevents nested cloned voice and deferred template wallet reservations on credits rail", () => {
    expect(runner).toContain('args.funding?.rail !== "credits" && await isWalletFunded');
    expect(narration).toContain('billing.funding?.rail !== "credits"');
    expect(runner).toContain('if (job.funding === "credits") {\n    videoFundingSnapshot(job);\n    return { funded: true, job, error: null };');
  });

  it("uses correction-owned funding and stable unique paid-operation identities", () => {
    expect(runner).toContain("storyboard-correction:${scene.id}:${attempt.id}");
    expect(runner).toContain("options: { meterFunding: attempt.meterFunding }");
    expect(runner).toContain("regeneration:${storyboard.regenerations}");
  });

  it("workers use durable rail rather than overwriting it with an enqueue argument", () => {
    expect(runner).toContain("coalesce(${videoGenerationsTable.funding}, ${funding})");
    expect(runner).toContain("executeVideoJob(claimed, claimed.funding ?? funding)");
  });
});