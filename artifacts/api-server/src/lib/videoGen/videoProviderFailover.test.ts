import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, videoGenSettingsTable } from "@workspace/db";
import { recordProviderFailure, resetProviderHealthForTests } from "../providerHealth";
import { generateVideo, videoGenHealthKey } from "./index";
import { VideoGenProviderError, type VideoGenResult } from "./types";
import { withVideoProviderTaskStore } from "./providerTaskContext";

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
vi.mock("./providers/atlascloud", () => ({
  ATLASCLOUD_SEEDANCE_25_T2V_MODEL: "bytedance/seedance-2.5/text-to-video",
  ATLASCLOUD_SEEDANCE_25_I2V_MODEL: "bytedance/seedance-2.5/image-to-video",
  generateWithAtlasCloud: vi.fn(),
}));

import { generateWithReplicate } from "./providers/replicate";
import { generateWithOpenRouterVideo } from "./providers/openrouter";
import { generateWithAtlasCloud } from "./providers/atlascloud";

const savedReplicate = process.env.REPLICATE_API_TOKEN;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;
const savedAtlas = process.env.ATLASCLOUD_API_KEY;
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
    vi.mocked(generateWithAtlasCloud).mockReset();
    resetProviderHealthForTests();
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "videogen_%"));
    await db.delete(videoGenSettingsTable);
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.ATLASCLOUD_API_KEY = "test-atlas-token";
  });
  afterAll(() => {
    if (savedReplicate === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = savedReplicate;
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouter;
    if (savedAtlas === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = savedAtlas;
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

  it("loads and saves an operation-scoped async provider task receipt", async () => {
    const load = vi.fn(async () => ({
      taskId: "task-existing",
      requestId: "request-existing",
    }));
    const save = vi.fn(async () => {});
    vi.mocked(generateWithReplicate).mockImplementation(async (input) => {
      expect(input.providerTaskId).toBe("task-existing");
      expect(input.providerRequestId).toBe("request-existing");
      await input.onProviderTaskAccepted?.({
        taskId: "task-accepted",
        requestId: "request-accepted",
      });
      return {
        buffer: Buffer.from("video"),
        provider: "replicate",
        model: "wan-video/wan-2.5-t2v",
      };
    });

    await withVideoProviderTaskStore({ load, save }, () =>
      generateVideo({ ...params, operationKey: "scene:one" })
    );

    expect(load).toHaveBeenCalledWith(
      "scene:one",
      "replicate",
      "wan-video/wan-2.5-t2v",
    );
    expect(save).toHaveBeenCalledWith(
      "scene:one",
      "replicate",
      "wan-video/wan-2.5-t2v",
      { taskId: "task-accepted", requestId: "request-accepted" },
    );
  });

  it("persists an operation-scoped submit marker without a task id across recovery and never POSTs it twice", async () => {
    const durable = new Map<string, {
      provider: string;
      model: string;
      submitStartedAt: string;
      taskId: string;
    }>();
    const store = () => ({
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      markSubmitStarted: vi.fn(async (operationKey: string, provider: string, model: string) => {
        durable.set(operationKey, {
          provider,
          model,
          submitStartedAt: "2026-09-07T00:00:00.000Z",
          taskId: "",
        });
      }),
      isSubmitUncertain: vi.fn(async (operationKey: string, provider: string, model: string) => {
        const receipt = durable.get(operationKey);
        return receipt?.provider === provider && receipt.model === model &&
          Boolean(receipt.submitStartedAt) && !receipt.taskId;
      }),
    });
    const atlasParams = {
      ...params,
      operationKey: "scene:atlas-one",
      resolvedVideoModel: {
        ...params.resolvedVideoModel,
        provider: "atlascloud",
        model: "bytedance/seedance-2.5/text-to-video",
      },
    };
    vi.mocked(generateWithAtlasCloud).mockImplementation(async (input) => {
      await input.onProviderSubmitStarted?.();
      throw new VideoGenProviderError("connection ended before acceptance", 503);
    });

    await expect(withVideoProviderTaskStore(store(), () => generateVideo(atlasParams)))
      .rejects.toThrow(/connection ended/);
    expect(durable.get("scene:atlas-one")).toMatchObject({
      provider: "atlascloud",
      taskId: "",
      submitStartedAt: expect.any(String),
    });
    const callsAfterFirstInvocation = vi.mocked(generateWithAtlasCloud).mock.calls.length;

    await expect(withVideoProviderTaskStore(store(), () => generateVideo(atlasParams)))
      .rejects.toThrow(/outcome is uncertain/);
    expect(vi.mocked(generateWithAtlasCloud)).toHaveBeenCalledTimes(callsAfterFirstInvocation);
  });
});