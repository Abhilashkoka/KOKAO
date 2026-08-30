import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, videoGenSettingsTable } from "@workspace/db";
import { recordProviderFailure, resetProviderHealthForTests } from "../providerHealth";
import { generateVideo, videoGenHealthKey } from "./index";
import { VideoGenProviderError, type VideoGenResult } from "./types";

vi.mock("../aiCost", () => ({ isVideoModelPriced: vi.fn(async () => true) }));
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

import { generateWithReplicate } from "./providers/replicate";
import { generateWithOpenRouterVideo } from "./providers/openrouter";

const savedReplicate = process.env.REPLICATE_API_TOKEN;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;
const params = {
  mode: "text" as const, prompt: "a pastel sunrise over still water",
  aspectRatio: "9:16" as const, durationSec: 5,
  resolvedVideoModel: {
    version: 1 as const, source: "explicit" as const, mode: "text" as const,
    provider: "replicate", model: "wan-video/wan-2.5-t2v", catalogModelId: "wan-2.5",
    durationSec: 5, resolution: "720p", quality: null, generateAudio: null,
    supportsEndFrame: true,
  },
};

describe("generateVideo exact-provider behavior", () => {
  beforeEach(async () => {
    vi.mocked(generateWithReplicate).mockReset();
    vi.mocked(generateWithOpenRouterVideo).mockReset();
    resetProviderHealthForTests();
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

  it("never diverts a frozen job to OpenRouter after a Replicate outage", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(
      new VideoGenProviderError("upstream 503", 503),
    );
    vi.mocked(generateWithOpenRouterVideo).mockResolvedValue({
      buffer: Buffer.from("wrong provider"), provider: "openrouter", model: "kwaivgi/kling-v3.0-std",
    } satisfies VideoGenResult);

    await expect(generateVideo(params)).rejects.toThrow("upstream 503");
    expect(generateWithReplicate).toHaveBeenCalledTimes(1);
    expect(generateWithOpenRouterVideo).not.toHaveBeenCalled();
  });

  it("still calls the frozen provider when its breaker is open; it never substitutes", async () => {
    const key = videoGenHealthKey("replicate");
    recordProviderFailure(key); recordProviderFailure(key); recordProviderFailure(key);
    vi.mocked(generateWithReplicate).mockResolvedValue({
      buffer: Buffer.from("video"), provider: "replicate", model: "wan-video/wan-2.5-t2v",
    } satisfies VideoGenResult);

    const output = await generateVideo(params);
    expect(output.provider).toBe("replicate");
    expect(generateWithReplicate).toHaveBeenCalledTimes(1);
    expect(generateWithOpenRouterVideo).not.toHaveBeenCalled();
  });
});