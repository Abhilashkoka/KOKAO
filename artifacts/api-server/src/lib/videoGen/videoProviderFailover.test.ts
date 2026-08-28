import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Hermetic: the failover path fires superadmin notifications and reads the
// price catalog — stub both so this suite exercises pure routing logic.
vi.mock("../notifications", () => ({
  notifyVideoGenFailover: vi.fn(async () => {}),
  resolveVideoGenFailoverNotifications: vi.fn(async () => {}),
}));
vi.mock("../aiCost", () => ({
  isVideoModelPriced: vi.fn(async () => true),
}));
// Candidate ordering now includes NVIDIA first. Its deployment state is stored
// in the shared dev DB, so force it inactive here and leave readiness/pricing
// behavior to the dedicated NVIDIA suites.
vi.mock("../nvidiaCore", () => ({
  resolveNvidiaCoreDeployment: vi.fn(async () => null),
  isNvidiaCoreDeploymentActivatable: vi.fn(async () => false),
}));
vi.mock("./providers/replicate", () => ({
  REPLICATE_T2V_MODEL: "wan-video/wan-2.2-t2v-fast",
  REPLICATE_I2V_MODEL: "wan-video/wan-2.2-i2v-fast",
  generateWithReplicate: vi.fn(),
}));
vi.mock("./providers/openrouter", () => ({
  OPENROUTER_T2V_MODEL: "kwaivgi/kling-v3.0-std",
  OPENROUTER_I2V_MODEL: "kwaivgi/kling-v3.0-std",
  generateWithOpenRouterVideo: vi.fn(),
}));

import { eq, like } from "drizzle-orm";
import { db, appCredentialsTable, videoGenSettingsTable } from "@workspace/db";
import {
  recordProviderFailure,
  resetProviderHealthForTests,
} from "../providerHealth";
import {
  generateVideo,
  resolveVideoGenFailoverCandidate,
  resetVideoGenFailoverNotifyThrottleForTests,
  videoGenHealthKey,
} from "./index";
import { VideoGenProviderError, type VideoGenResult } from "./types";
import { generateWithReplicate } from "./providers/replicate";
import { generateWithOpenRouterVideo } from "./providers/openrouter";
import { isVideoModelPriced } from "../aiCost";
import {
  notifyVideoGenFailover,
  resolveVideoGenFailoverNotifications,
} from "../notifications";

const savedReplicate = process.env.REPLICATE_API_TOKEN;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;

function result(provider: string, model: string): VideoGenResult {
  return { buffer: Buffer.from(model), provider, model };
}

const params = {
  mode: "text" as const,
  prompt: "a pastel sunrise over still water",
  aspectRatio: "9:16" as const,
  durationSec: 5,
};

const transient = () => new VideoGenProviderError("upstream 503", 503);

/** Trip the replicate breaker open (3 consecutive transient failures). */
function openReplicateBreaker() {
  const key = videoGenHealthKey("replicate");
  recordProviderFailure(key);
  recordProviderFailure(key);
  recordProviderFailure(key);
}

describe("generateVideo provider failover", () => {
  beforeEach(async () => {
    vi.mocked(generateWithReplicate).mockReset();
    vi.mocked(generateWithOpenRouterVideo).mockReset();
    vi.mocked(isVideoModelPriced).mockReset();
    vi.mocked(isVideoModelPriced).mockResolvedValue(true);
    vi.mocked(notifyVideoGenFailover).mockClear();
    vi.mocked(resolveVideoGenFailoverNotifications).mockClear();
    resetProviderHealthForTests();
    resetVideoGenFailoverNotifyThrottleForTests();
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "videogen_%"));
    await db.delete(videoGenSettingsTable);
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  afterAll(() => {
    if (savedReplicate === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = savedReplicate;
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouter;
  });

  it("serves via the substitute provider after the primary chain exhausts, and alerts once", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(transient());
    vi.mocked(generateWithOpenRouterVideo).mockResolvedValue(
      result("openrouter", "kwaivgi/kling-v3.0-std"),
    );

    const out = await generateVideo(params);
    expect(out.provider).toBe("openrouter");
    expect(out.model).toBe("kwaivgi/kling-v3.0-std");
    // Primary walked its full model chain (1 + 2 fallbacks) first.
    expect(generateWithReplicate).toHaveBeenCalledTimes(3);
    expect(generateWithOpenRouterVideo).toHaveBeenCalledTimes(1);
    expect(notifyVideoGenFailover).toHaveBeenCalledTimes(1);
    expect(notifyVideoGenFailover).toHaveBeenCalledWith(
      expect.objectContaining({
        fromProvider: "replicate",
        toProvider: "openrouter",
        model: "kwaivgi/kling-v3.0-std",
        lastError: "upstream 503",
      }),
    );
  });

  it("throttles the alert to once per outage window", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(transient());
    vi.mocked(generateWithOpenRouterVideo).mockResolvedValue(
      result("openrouter", "kwaivgi/kling-v3.0-std"),
    );

    await generateVideo(params);
    await generateVideo(params);
    expect(notifyVideoGenFailover).toHaveBeenCalledTimes(1);
  });

  it("never fails over on a permanent primary failure", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(
      new VideoGenProviderError("prompt rejected by the safety filter", 400),
    );

    await expect(generateVideo(params)).rejects.toThrow("prompt rejected");
    expect(generateWithOpenRouterVideo).not.toHaveBeenCalled();
    expect(notifyVideoGenFailover).not.toHaveBeenCalled();
  });

  it("surfaces the primary error when no candidate exists", async () => {
    // The shared dev DB may hold a real textgen_openrouter key that makes
    // OpenRouter "configured" — pin the no-candidate case via the test seam.
    vi.mocked(generateWithReplicate).mockRejectedValue(transient());

    await expect(
      generateVideo(params, { resolveCandidate: async () => null }),
    ).rejects.toThrow("upstream 503");
    expect(generateWithOpenRouterVideo).not.toHaveBeenCalled();
  });

  it("respects the pricing gate: an unpriced substitute is never used", async () => {
    vi.mocked(isVideoModelPriced).mockImplementation(async ({ provider }) => provider === "replicate");
    vi.mocked(generateWithReplicate).mockRejectedValue(transient());

    await expect(generateVideo(params)).rejects.toThrow("upstream 503");
    expect(generateWithOpenRouterVideo).not.toHaveBeenCalled();
  });

  it("re-checks a substitute's price immediately before its provider call", async () => {
    openReplicateBreaker();
    vi.mocked(isVideoModelPriced).mockResolvedValue(false);
    vi.mocked(generateWithReplicate).mockRejectedValue(transient());

    await expect(generateVideo(params)).rejects.toThrow();
    expect(generateWithOpenRouterVideo).not.toHaveBeenCalled();
  });

  it("diverts immediately when the primary breaker is already open", async () => {
    openReplicateBreaker();
    vi.mocked(generateWithOpenRouterVideo).mockResolvedValue(
      result("openrouter", "kwaivgi/kling-v3.0-std"),
    );

    const out = await generateVideo(params);
    expect(out.provider).toBe("openrouter");
    expect(generateWithReplicate).not.toHaveBeenCalled();
    expect(notifyVideoGenFailover).toHaveBeenCalledTimes(1);
    expect(notifyVideoGenFailover).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: null }),
    );
  });

  it("surfaces the primary outage when the substitute also fails", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(transient());
    vi.mocked(generateWithOpenRouterVideo).mockRejectedValue(
      new VideoGenProviderError("substitute 502", 502),
    );

    await expect(generateVideo(params)).rejects.toThrow("upstream 503");
  });

  it("resolves the alert and re-arms the throttle when the primary recovers", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValueOnce(transient());
    vi.mocked(generateWithReplicate).mockResolvedValue(
      result("replicate", "wan-video/wan-2.5-t2v"),
    );

    // One transient failure then a within-chain success = recovery path.
    const out = await generateVideo(params);
    expect(out.provider).toBe("replicate");
    await vi.waitFor(() =>
      expect(resolveVideoGenFailoverNotifications).toHaveBeenCalledWith("replicate"),
    );
  });
});

describe("resolveVideoGenFailoverCandidate", () => {
  beforeEach(async () => {
    vi.mocked(isVideoModelPriced).mockReset();
    vi.mocked(isVideoModelPriced).mockResolvedValue(true);
    resetProviderHealthForTests();
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "videogen_%"));
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  it("returns the other configured, healthy, priced static provider", async () => {
    const candidate = await resolveVideoGenFailoverCandidate("replicate", "text");
    expect(candidate?.def.id).toBe("openrouter");
    expect(candidate?.model).toBe("kwaivgi/kling-v3.0-std");
  });

  it("skips unconfigured providers", async () => {
    delete process.env.OPENROUTER_API_KEY;
    // OpenRouter video shares the admin-saved TEXT key (textgen_openrouter),
    // so temporarily stash any real row rather than destroying shared state.
    const saved = await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "textgen_openrouter"));
    try {
      await db
        .delete(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, "textgen_openrouter"));
      expect(await resolveVideoGenFailoverCandidate("replicate", "text")).toBeNull();
    } finally {
      if (saved[0]) {
        await db.insert(appCredentialsTable).values(saved[0]).onConflictDoNothing();
      }
    }
  });

  it("skips providers whose breaker is open", async () => {
    const key = videoGenHealthKey("openrouter");
    recordProviderFailure(key);
    recordProviderFailure(key);
    recordProviderFailure(key);
    expect(await resolveVideoGenFailoverCandidate("replicate", "text")).toBeNull();
  });

  it("skips providers without a price row (pricing gate)", async () => {
    vi.mocked(isVideoModelPriced).mockImplementation(async ({ provider }) => provider === "replicate");
    expect(await resolveVideoGenFailoverCandidate("replicate", "text")).toBeNull();
  });

  it("never proposes the primary itself", async () => {
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
    const candidate = await resolveVideoGenFailoverCandidate("openrouter", "text");
    expect(candidate?.def.id).toBe("replicate");
  });
});
