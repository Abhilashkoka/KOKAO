import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, videoGenSettingsTable } from "@workspace/db";
import { getProviderHealth, resetProviderHealthForTests } from "../providerHealth";
import {
  generateVideo,
  getVideoGenSelection,
  hasNativeSynchronizedAudio,
  setVideoGenSelection,
} from "./index";
import { VideoGenProviderError, type VideoGenResult } from "./types";

vi.mock("../aiCost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiCost")>()),
  isVideoModelPriced: vi.fn(async () => true),
}));
vi.mock("../nvidiaCore", () => ({
  resolveNvidiaCoreDeployment: vi.fn(async () => null),
  isNvidiaCoreDeploymentActivatable: vi.fn(async () => false),
}));
vi.mock("./providers/replicate", () => ({
  REPLICATE_T2V_MODEL: "wan-video/wan-2.2-t2v-fast",
  REPLICATE_I2V_MODEL: "wan-video/wan-2.2-i2v-fast",
  generateWithReplicate: vi.fn(),
}));

import { generateWithReplicate } from "./providers/replicate";
import { isVideoModelPriced } from "../aiCost";

const savedToken = process.env.REPLICATE_API_TOKEN;
const frozenText = {
  version: 1 as const, source: "explicit" as const, mode: "text" as const,
  provider: "replicate", model: "wan-video/wan-2.5-t2v", catalogModelId: "wan-2.5",
  durationSec: 5, resolution: "720p", quality: null, generateAudio: null,
  supportsEndFrame: true,
};
const params = {
  mode: "text" as const, prompt: "a pastel sunrise over still water",
  aspectRatio: "9:16" as const, durationSec: 5, resolvedVideoModel: frozenText,
};

describe("generateVideo frozen model contract", () => {
  beforeEach(async () => {
    vi.mocked(generateWithReplicate).mockReset();
    vi.mocked(isVideoModelPriced).mockReset();
    vi.mocked(isVideoModelPriced).mockResolvedValue(true);
    resetProviderHealthForTests();
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "videogen_%"));
    await db.delete(videoGenSettingsTable);
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
  });

  afterAll(() => {
    if (savedToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = savedToken;
  });

  it("uses exactly the frozen provider/model and variants after settings change", async () => {
    await setVideoGenSelection({
      provider: "replicate", textToVideoModel: "google/veo-3",
      imageToVideoModel: "google/veo-3",
    });
    vi.mocked(generateWithReplicate).mockResolvedValue({
      buffer: Buffer.from("video"), provider: "replicate", model: frozenText.model,
    } satisfies VideoGenResult);

    const output = await generateVideo(params);
    expect(output.model).toBe(frozenText.model);
    expect(vi.mocked(generateWithReplicate).mock.calls).toHaveLength(1);
    expect(vi.mocked(generateWithReplicate).mock.calls[0]![0]).toMatchObject({
      model: frozenText.model, resolution: "720p", quality: null, generateAudio: null,
    });
  });

  it("does not substitute another model after a transient failure", async () => {
    vi.mocked(generateWithReplicate).mockRejectedValue(
      new VideoGenProviderError("queue backed up", 503),
    );
    await expect(generateVideo(params)).rejects.toThrow("queue backed up");
    expect(vi.mocked(generateWithReplicate).mock.calls.map((call) => call[0].model))
      .toEqual([frozenText.model]);
    expect(getProviderHealth("videogen:replicate")?.consecutiveFailures).toBe(1);
  });

  it("rejects calls that lack an immutable snapshot", async () => {
    const { resolvedVideoModel: _snapshot, ...legacy } = params;
    await expect(generateVideo(legacy)).rejects.toThrow(/frozen video provider\/model snapshot/i);
    expect(generateWithReplicate).not.toHaveBeenCalled();
  });

  it("rejects a scene duration that was not priced and funded in the snapshot", async () => {
    await expect(generateVideo({
      ...params,
      durationSec: 8,
      resolvedVideoModel: { ...frozenText, permittedDurationSec: [5] },
    })).rejects.toThrow(/outside this job's funded video model contract/i);
    expect(generateWithReplicate).not.toHaveBeenCalled();
  });

  it("allows a properly priced composite scene duration from its frozen contract", async () => {
    vi.mocked(generateWithReplicate).mockResolvedValue({
      buffer: Buffer.from("video"), provider: "replicate", model: frozenText.model,
    } satisfies VideoGenResult);
    const output = await generateVideo({
      ...params,
      durationSec: 8,
      resolvedVideoModel: { ...frozenText, permittedDurationSec: [5, 8, 10] },
    });
    expect(vi.mocked(generateWithReplicate).mock.calls[0]![0].durationSec).toBe(8);
  });

  it("quantizes an 8s scene target to a frozen 5s-only model without substitution", async () => {
    vi.mocked(generateWithReplicate).mockResolvedValue({
      buffer: Buffer.from("video"), provider: "replicate", model: frozenText.model,
    } satisfies VideoGenResult);
    const output = await generateVideo({
      ...params,
      durationSec: 8,
      resolvedVideoModel: {
        ...frozenText,
        permittedDurationSec: [5],
        durationPolicy: "nearest",
      },
    });
    expect(vi.mocked(generateWithReplicate).mock.calls).toHaveLength(1);
    expect(output.effectiveDurationSec).toBe(5);
    expect(vi.mocked(generateWithReplicate).mock.calls[0]![0]).toMatchObject({
      model: frozenText.model,
      durationSec: 5,
    });
  });

  it("keeps the legacy override normalization behavior for administration", async () => {
    await setVideoGenSelection({
      provider: "replicate", textToVideoModel: "google/veo-3.1",
      imageToVideoModel: "minimax/video-01",
    });
    const selection = await getVideoGenSelection();
    expect(selection.textToVideoModel).toBeNull();
    expect(selection.imageToVideoModel).toBeNull();
  });

  it("recognizes Seedance 2.5 as providing synchronized native audio", () => {
    expect(hasNativeSynchronizedAudio("openrouter", "bytedance/seedance-2.5")).toBe(true);
    expect(hasNativeSynchronizedAudio("OPENROUTER", " ByteDance/Seedance-2.5 ")).toBe(true);
    expect(hasNativeSynchronizedAudio("openrouter", "bytedance/seedance-2.0")).toBe(false);
  });
});