import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateLipSyncWithReplicate,
  generateWithReplicate,
  REPLICATE_LIP_SYNC_MODEL,
  REPLICATE_LIP_SYNC_VERSION,
} from "./providers/replicate";
import { LATENT_SYNC, portraitLipSyncModel } from "./lipSyncModels";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Replicate LatentSync prediction request", () => {
  it("uses the universal endpoint with the pinned community-model version", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let uploadNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const stringUrl = String(url);
        calls.push({ url: stringUrl, init });

        if (stringUrl === "https://api.replicate.com/v1/files") {
          uploadNumber += 1;
          return new Response(
            JSON.stringify({
              urls: { get: `https://api.replicate.com/v1/files/input-${uploadNumber}` },
            }),
            { status: 201 },
          );
        }
        if (stringUrl === "https://api.replicate.com/v1/predictions") {
          return new Response(
            JSON.stringify({
              id: "prediction-1",
              status: "succeeded",
              output: "https://replicate.delivery/output.mp4",
            }),
            { status: 201 },
          );
        }
        if (stringUrl === "https://replicate.delivery/output.mp4") {
          return new Response(Buffer.from("video-bytes"), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await generateLipSyncWithReplicate(
      {
        source: { buffer: Buffer.from("source-video"), mimeType: "video/mp4" },
        audio: { buffer: Buffer.from("narration"), mimeType: "audio/wav" },
        def: LATENT_SYNC,
      },
      "test-token",
    );

    const predictionCall = calls.find(
      ({ url }) => url === "https://api.replicate.com/v1/predictions",
    );
    expect(predictionCall).toBeDefined();
    expect(JSON.parse(String(predictionCall?.init?.body))).toEqual({
      version:
        "bytedance/latentsync:637ce1919f807ca20da3a448ddc2743535d2853649574cd52a933120e9b9e293",
      input: {
        video: "https://api.replicate.com/v1/files/input-1",
        audio: "https://api.replicate.com/v1/files/input-2",
      },
    });
    expect(
      calls.some(({ url }) =>
        url.includes(`/v1/models/${REPLICATE_LIP_SYNC_MODEL}/predictions`),
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      provider: "replicate",
      model: REPLICATE_LIP_SYNC_MODEL,
    });
    expect(result.buffer.toString()).toBe("video-bytes");
  });

  it("keeps unversioned official models on their model-specific endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const stringUrl = String(url);
        calls.push({ url: stringUrl, init });
        if (
          stringUrl ===
          "https://api.replicate.com/v1/models/wan-video/wan-2.2-t2v-fast/predictions"
        ) {
          return new Response(
            JSON.stringify({
              id: "prediction-2",
              status: "succeeded",
              output: "https://replicate.delivery/official-output.mp4",
            }),
            { status: 201 },
          );
        }
        if (stringUrl === "https://replicate.delivery/official-output.mp4") {
          return new Response(Buffer.from("official-video"), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await generateWithReplicate(
      {
        prompt: "A presenter speaks to camera",
        aspectRatio: "9:16",
        durationSec: 5,
        model: "wan-video/wan-2.2-t2v-fast",
      },
      "test-token",
    );

    const predictionCall = calls.find(({ url }) => url.includes("/predictions"));
    expect(predictionCall?.url).toBe(
      "https://api.replicate.com/v1/models/wan-video/wan-2.2-t2v-fast/predictions",
    );
    expect(JSON.parse(String(predictionCall?.init?.body))).toEqual({
      input: {
        prompt: expect.any(String),
        aspect_ratio: "9:16",
      },
    });
    expect(calls.some(({ url }) => url === "https://api.replicate.com/v1/predictions")).toBe(
      false,
    );
  });

  it("sends a portrait under the model's own input keys", async () => {
    // The portrait model is admin-configured, so the adapter must not assume
    // "video"/"audio": it uses whatever field names the definition declares.
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const stringUrl = String(url);
        calls.push({ url: stringUrl, init });
        if (stringUrl === "https://api.replicate.com/v1/files") {
          return Response.json({
            urls: { get: `https://api.replicate.com/v1/files/input-${calls.length}` },
          });
        }
        if (stringUrl === "https://api.replicate.com/v1/predictions") {
          return Response.json({
            id: "pred-1",
            status: "succeeded",
            output: "https://replicate.delivery/output.mp4",
          });
        }
        if (stringUrl === "https://replicate.delivery/output.mp4") {
          return new Response(Buffer.from("video-bytes"), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await generateLipSyncWithReplicate(
      {
        source: { buffer: Buffer.from("portrait"), mimeType: "image/png" },
        audio: { buffer: Buffer.from("voice"), mimeType: "audio/mpeg" },
        def: portraitLipSyncModel("acme/talking-head:abc123")!,
      },
      "test-token",
    );

    const predictionCall = calls.find(
      ({ url }) => url === "https://api.replicate.com/v1/predictions",
    );
    expect(JSON.parse(String(predictionCall?.init?.body))).toEqual({
      version: "acme/talking-head:abc123",
      input: {
        image: "https://api.replicate.com/v1/files/input-1",
        audio: "https://api.replicate.com/v1/files/input-2",
      },
    });
    expect(result.model).toBe("acme/talking-head");
  });
});
