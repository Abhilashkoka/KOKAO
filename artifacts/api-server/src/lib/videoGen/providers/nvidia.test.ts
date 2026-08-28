import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateWithNvidiaNimVideo } from "./nvidia";
import type { VideoGenInput } from "../types";

const { resolveDeployment, isActivatable } = vi.hoisted(() => ({
  resolveDeployment: vi.fn(),
  isActivatable: vi.fn(),
}));

vi.mock("../../nvidiaCore", () => ({
  resolveNvidiaCoreDeployment: resolveDeployment,
  isNvidiaCoreDeploymentActivatable: isActivatable,
}));

const realFetch = globalThis.fetch;
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 20]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
]);

const baseInput: VideoGenInput = {
  prompt: "A paper kite",
  aspectRatio: "16:9",
  durationSec: 12,
  model: "wan-ai/wan2.2",
  seed: 42,
};

beforeEach(() => {
  globalThis.fetch = realFetch;
  isActivatable.mockResolvedValue(true);
  resolveDeployment.mockResolvedValue({
    capability: "video",
    kind: "self-hosted",
    protocol: "nvidia-video-v1",
    model: "wan-ai/wan2.2",
    baseUrl: "https://nim.example/v1",
    resolvedApiKey: "endpoint-key",
  });
});

describe("NVIDIA Visual GenAI NIM video adapter", () => {
  it("sends the official synchronous T2V contract and decodes MP4", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ data: { b64_json: mp4.toString("base64") } }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await generateWithNvidiaNimVideo(baseInput, null);
    expect(result.buffer).toEqual(mp4);
    expect(result).toMatchObject({ provider: "nvidia", model: "wan-ai/wan2.2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nim.example/v1/videos/generations",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer endpoint-key",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      prompt: "A paper kite",
      size: "832x480",
      model: "wan-ai/wan2.2",
      seconds: 12,
      seed: 42,
    });
  });

  it("sends a portrait I2V input_reference data URI", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ data: { b64_json: mp4.toString("base64") } }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    await generateWithNvidiaNimVideo(
      {
        ...baseInput,
        aspectRatio: "9:16",
        durationSec: 1,
        image: { buffer: Buffer.from("image"), mimeType: "image/png" },
      },
      null,
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      size: "480x832",
      seconds: 1,
      input_reference: "data:image/png;base64,aW1hZ2U=",
    });
  });

  it("rejects decoded data that is not MP4", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: { b64_json: Buffer.from("not video").toString("base64") } }),
    ) as typeof fetch;
    await expect(generateWithNvidiaNimVideo(baseInput, null)).rejects.toThrow("valid MP4");
  });
});