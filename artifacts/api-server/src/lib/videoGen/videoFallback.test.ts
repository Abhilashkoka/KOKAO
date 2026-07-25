import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, videoGenSettingsTable } from "@workspace/db";
import { getProviderHealth, resetProviderHealthForTests } from "../providerHealth";
import { generateVideo, setVideoGenSelection } from "./index";
import { VideoGenProviderError, type VideoGenResult } from "./types";

vi.mock("./providers/replicate", () => ({
  REPLICATE_T2V_MODEL: "wan-video/wan-2.2-t2v-fast",
  REPLICATE_I2V_MODEL: "wan-video/wan-2.2-i2v-fast",
  generateWithReplicate: vi.fn(),
}));

import { generateWithReplicate } from "./providers/replicate";

const savedToken = process.env.REPLICATE_API_TOKEN;

function result(model: string): VideoGenResult {
  return { buffer: Buffer.from(model), provider: "replicate", model };
}

/** The models a call actually reached, in order. */
function attemptedModels(): string[] {
  return vi.mocked(generateWithReplicate).mock.calls.map((call) => call[0].model);
}

const params = {
  mode: "text" as const,
  prompt: "a pastel sunrise over still water",
  aspectRatio: "9:16" as const,
  durationSec: 5,
};

describe("generateVideo model fallback", () => {
  beforeEach(async () => {
    vi.mocked(generateWithReplicate).mockReset();
    resetProviderHealthForTests();
    // Stored admin keys would override env config; clear them for determinism.
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "videogen_%"));
    await db.delete(videoGenSettingsTable);
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
  });

  afterAll(() => {
    if (savedToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = savedToken;
  });

  it("retries on the next catalog model after a transient failure", async () => {
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("queue backed up", 503))
      .mockResolvedValueOnce(result("google/veo-3-fast"));

    const out = await generateVideo(params);
    expect(out.model).toBe("google/veo-3-fast");
    expect(attemptedModels()).toEqual(["wan-video/wan-2.2-t2v-fast", "google/veo-3-fast"]);
  });

  it("does not advance the chain on a permanent failure", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(
      new VideoGenProviderError("prompt rejected by the safety filter", 400),
    );

    await expect(generateVideo(params)).rejects.toThrow("prompt rejected");
    expect(generateWithReplicate).toHaveBeenCalledTimes(1);
  });

  it("tries at most two other models, then reports the configured one's failure", async () => {
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("configured model down", 503))
      .mockRejectedValueOnce(new VideoGenProviderError("second down", 502))
      .mockRejectedValueOnce(new VideoGenProviderError("third down", 429));

    await expect(generateVideo(params)).rejects.toThrow("configured model down");
    expect(attemptedModels()).toEqual([
      "wan-video/wan-2.2-t2v-fast",
      "google/veo-3-fast",
      "minimax/video-01",
    ]);
  });

  it("keeps walking the chain when a fallback model is unreachable on this account", async () => {
    // A 404 on a fallback is permanent for THAT model but says nothing about
    // the job — it must not surface instead of the real failure.
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("configured model down", 503))
      .mockRejectedValueOnce(new VideoGenProviderError("model not found", 404))
      .mockResolvedValueOnce(result("minimax/video-01"));

    const out = await generateVideo(params);
    expect(out.model).toBe("minimax/video-01");
  });

  it("reports the configured model's error when every fallback is unreachable", async () => {
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("configured model down", 503))
      .mockRejectedValueOnce(new VideoGenProviderError("model not found", 404))
      .mockRejectedValueOnce(new VideoGenProviderError("no access", 402));

    await expect(generateVideo(params)).rejects.toThrow("configured model down");
  });

  it("starts the chain at the admin's model override", async () => {
    await setVideoGenSelection({
      provider: "replicate",
      textToVideoModel: "google/veo-3-fast",
      imageToVideoModel: null,
    });
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("down", 503))
      .mockResolvedValueOnce(result("wan-video/wan-2.2-t2v-fast"));

    await generateVideo(params);
    expect(attemptedModels()).toEqual(["google/veo-3-fast", "wan-video/wan-2.2-t2v-fast"]);
  });

  it("uses the image-to-video chain in image mode", async () => {
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("down", 503))
      .mockResolvedValueOnce(result("minimax/video-01"));

    await generateVideo({
      ...params,
      mode: "image",
      image: { buffer: Buffer.from("png"), mimeType: "image/png" },
    });
    expect(attemptedModels()).toEqual(["wan-video/wan-2.2-i2v-fast", "minimax/video-01"]);
    expect(vi.mocked(generateWithReplicate).mock.calls[1]![0].image).toBeDefined();
  });

  it("records transient failures against the provider and clears them on success", async () => {
    vi.mocked(generateWithReplicate)
      .mockRejectedValueOnce(new VideoGenProviderError("down", 503))
      .mockRejectedValueOnce(new VideoGenProviderError("down", 503))
      .mockRejectedValueOnce(new VideoGenProviderError("down", 503));

    await expect(generateVideo(params)).rejects.toThrow();
    expect(getProviderHealth("videogen:replicate")?.consecutiveFailures).toBe(3);

    vi.mocked(generateWithReplicate).mockResolvedValue(result("wan-video/wan-2.2-t2v-fast"));
    await generateVideo(params);
    expect(getProviderHealth("videogen:replicate")?.consecutiveFailures).toBe(0);
  });

  it("does not count a permanent failure against provider health", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(
      new VideoGenProviderError("prompt rejected", 400),
    );

    await expect(generateVideo(params)).rejects.toThrow();
    expect(getProviderHealth("videogen:replicate")).toBeNull();
  });
});
