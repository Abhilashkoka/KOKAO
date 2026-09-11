import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type https from "node:https";

const meterMock = vi.hoisted(() =>
  vi.fn(async <T>(_ctx: unknown, _kind: string, _quantity: number, fn: () => Promise<T>) => fn()),
);
vi.mock("../../meter", () => ({ meter: meterMock }));

vi.mock("../../webFetch", () => ({
  assertPublicHost: vi.fn(async () => {}),
  resolvePublicHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import {
  ATLASCLOUD_SEEDANCE_25_I2V_MODEL,
  ATLASCLOUD_SEEDANCE_25_T2V_MODEL,
  ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL,
  atlasCloudRequestBody,
  atlasVideoReceipt,
  generateWithAtlasCloud,
  pinnedDownload,
  setAtlasPinnedDownloadForTest,
  type AtlasPinnedDownloadDependencies,
} from "./atlascloud";
import { VideoGenProviderError, type VideoGenInput } from "../types";

const input: VideoGenInput = {
  meterContext: null,
  prompt: "A presenter turns to camera",
  aspectRatio: "9:16",
  durationSec: 8,
  resolution: "720p",
  generateAudio: true,
  model: ATLASCLOUD_SEEDANCE_25_T2V_MODEL,
};

function fakeHttpsRequest(
  statusCode: number,
  onResponse?: (response: IncomingMessage) => void,
) {
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
  });
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    destroy: vi.fn(),
  });
  const factory = vi.fn((
    _options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    queueMicrotask(() => {
      callback(response as unknown as IncomingMessage);
      onResponse?.(response as unknown as IncomingMessage);
    });
    return request as unknown as ClientRequest;
  });
  return { factory, request, response };
}

function pinnedDependencies(
  factory: ReturnType<typeof fakeHttpsRequest>["factory"],
  overrides: Partial<AtlasPinnedDownloadDependencies> = {},
): AtlasPinnedDownloadDependencies {
  return {
    request: factory as AtlasPinnedDownloadDependencies["request"],
    resolveHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    ...overrides,
  };
}

describe("Atlas Cloud Seedance 2.5", () => {
  beforeEach(() => {
    meterMock.mockClear();
    setAtlasPinnedDownloadForTest(async () => Buffer.from("video-bytes"));
  });
  afterEach(() => setAtlasPinnedDownloadForTest(null));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("accepts only clearly labelled video-token and actual-USD receipt fields", () => {
    expect(atlasVideoReceipt({
      usage: { video_tokens: "250000", total_tokens: 999999 },
      actual_cost_usd: "1.75",
    })).toEqual({ providerReportedActualUsd: 1.75, videoTokens: 250000 });
    expect(atlasVideoReceipt({
      usage: { total_tokens: 999999, input_tokens: 1, output_tokens: 2 },
    })).toEqual({});
  });

  it("uses the documented text and image endpoint model contracts", () => {
    expect(atlasCloudRequestBody(input)).toMatchObject({
      model: ATLASCLOUD_SEEDANCE_25_T2V_MODEL,
      duration: 8, ratio: "9:16", resolution: "720p", generate_audio: true,
    });
    const image = atlasCloudRequestBody({
      ...input,
      model: ATLASCLOUD_SEEDANCE_25_I2V_MODEL,
      image: { buffer: Buffer.from("first"), mimeType: "image/png" },
      endImage: { buffer: Buffer.from("last"), mimeType: "image/jpeg" },
    });
    expect(image).toMatchObject({
      model: ATLASCLOUD_SEEDANCE_25_I2V_MODEL,
      ratio: "adaptive",
      image: "data:image/png;base64,Zmlyc3Q=",
      last_image: "data:image/jpeg;base64,bGFzdA==",
    });
  });

  it("sends only provider asset references for reference-to-video", () => {
    const body = atlasCloudRequestBody({
      ...input,
      model: ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL,
      assetIds: ["asset-fictional-one", "asset-fictional-two"],
    });
    expect(body).toMatchObject({
      model: ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL,
      reference_images: ["asset://asset-fictional-one", "asset://asset-fictional-two"],
    });
    expect(body).not.toHaveProperty("image");
    expect(body).not.toHaveProperty("ratio");
    expect(body.prompt).toContain("@Image1 and @Image2");
  });

  it.each(["asset-💥", " asset-2026-valid", "asset-2026 bad", "atlas-asset-2026"])(
    "rejects malformed Atlas generation references before provider submission (%s)",
    async (assetId) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(() => atlasCloudRequestBody({
        ...input,
        model: ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL,
        assetIds: [assetId],
      })).toThrow(/invalid Asset Library generation reference/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("checkpoints an accepted prediction and downloads only completed output", async () => {
    const accepted = vi.fn(async () => {});
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/generateVideo")) {
        return new Response(JSON.stringify({ code: 0, data: {
          id: "prediction-1", status: "completed", outputs: ["https://media.example/result.mp4"],
        } }));
      }
      if (url === "https://media.example/result.mp4") return new Response("video-bytes");
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    await expect(generateWithAtlasCloud({
      ...input,
      meterContext: { tenantId: 1, operationKey: "atlas:clip" },
      onProviderTaskAccepted: accepted,
    }, "secret"))
      .resolves.toMatchObject({ provider: "atlascloud", providerTaskId: "prediction-1" });
    expect(meterMock.mock.calls[0]?.slice(0, 3)).toEqual([
      {
        tenantId: 1,
        operationFamilyKey: "atlas:clip",
        operationKey: "atlas:clip:submit:0",
        provider: "atlascloud",
        model: ATLASCLOUD_SEEDANCE_25_T2V_MODEL,
      },
      "video_hd",
      8,
    ]);
    expect(accepted).toHaveBeenCalledWith({ taskId: "prediction-1", requestId: null });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.atlascloud.ai/api/v1/model/generateVideo");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST", headers: { Authorization: "Bearer secret" },
    });
  });

  it("resumes a stored prediction without another paid POST", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      if (url.endsWith("/prediction/prediction-existing")) {
        return new Response(JSON.stringify({ code: 0, data: {
          id: "prediction-existing", status: "completed", outputs: ["https://media.example/resumed.mp4"],
        } }));
      }
      if (url === "https://media.example/resumed.mp4") return new Response("resumed");
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const generation = generateWithAtlasCloud({ ...input, providerTaskId: "prediction-existing" }, "secret");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(generation).resolves.toMatchObject({ providerTaskId: "prediction-existing" });
    expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("keeps polling an accepted prediction beyond the shared ten-minute budget", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/generateVideo")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ code: 0, data: {
          id: "prediction-slow", status: "processing",
        } }));
      }
      if (url.endsWith("/prediction/prediction-slow")) {
        expect(init?.method).toBe("GET");
        polls += 1;
        return new Response(JSON.stringify({ code: 0, data:
          polls > 120
            ? {
                id: "prediction-slow",
                status: "completed",
                outputs: ["https://media.example/slow.mp4"],
              }
            : { id: "prediction-slow", status: "processing" },
        }));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const generation = generateWithAtlasCloud(input, "secret");
    await vi.advanceTimersByTimeAsync((10 * 60 * 1000) + 5_000);

    await expect(generation).resolves.toMatchObject({
      providerTaskId: "prediction-slow",
    });
    expect(polls).toBe(121);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not retry an ambiguous failed generation POST", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(generateWithAtlasCloud(input, "secret")).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records a 402 as a definite rejection with no accepted paid task", async () => {
    const submitStarted = vi.fn(async () => {});
    const submitRejected = vi.fn(async () => {});
    const accepted = vi.fn(async () => {});
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ message: "unknown provider error" }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithAtlasCloud({
      ...input,
      onProviderSubmitStarted: submitStarted,
      onProviderSubmitRejected: submitRejected,
      onProviderTaskAccepted: accepted,
    }, "secret")).rejects.toMatchObject({
      status: 402,
      message: expect.stringMatching(/insufficient provider credits|unavailable billing/i),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(submitStarted).toHaveBeenCalledTimes(1);
    expect(submitRejected).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("pins lookup to the validated address while preserving the TLS hostname", async () => {
    const transport = fakeHttpsRequest(200, (response) => {
      response.emit("data", Buffer.from("video"));
      response.emit("end");
    });
    const resolveHost = vi.fn(async () => [{ address: "2001:db8::8", family: 6 }]);

    await expect(pinnedDownload(
      "https://media.example:8443/path/video.mp4?token=one",
      pinnedDependencies(transport.factory, { resolveHost }),
    )).resolves.toEqual(Buffer.from("video"));

    expect(resolveHost).toHaveBeenCalledWith("media.example");
    const options = transport.factory.mock.calls[0]![0];
    expect(options).toMatchObject({
      hostname: "media.example",
      port: "8443",
      path: "/path/video.mp4?token=one",
      servername: "media.example",
    });
    const lookupCallback = vi.fn();
    const lookup = options.lookup as (
      hostname: string,
      options: object,
      callback: (error: null, address: string, family: number) => void,
    ) => void;
    lookup("ignored-by-pin.example", {}, lookupCallback);
    expect(lookupCallback).toHaveBeenCalledWith(null, "2001:db8::8", 6);

    const allLookupCallback = vi.fn();
    lookup("ignored-by-pin.example", { all: true }, allLookupCallback);
    expect(allLookupCallback).toHaveBeenCalledWith(null, [
      { address: "2001:db8::8", family: 6 },
    ]);
  });

  it("falls back to the next validated CDN address after a transport failure", async () => {
    const firstRequest = Object.assign(new EventEmitter(), {
      end: vi.fn(function (this: EventEmitter) {
        queueMicrotask(() => this.emit("error", new Error("unreachable")));
      }),
      destroy: vi.fn(),
    });
    const second = fakeHttpsRequest(200, (response) => {
      response.emit("data", Buffer.from("video"));
      response.emit("end");
    });
    const request = vi.fn()
      .mockReturnValueOnce(firstRequest)
      .mockImplementation(second.factory);
    const resolveHost = vi.fn(async () => [
      { address: "2001:db8::8", family: 6 as const },
      { address: "93.184.216.34", family: 4 as const },
    ]);

    await expect(pinnedDownload(
      "https://media.example/video.mp4",
      pinnedDependencies(request, { resolveHost }),
    )).resolves.toEqual(Buffer.from("video"));

    expect(request).toHaveBeenCalledTimes(2);
    const secondOptions = request.mock.calls[1]![0];
    const lookupCallback = vi.fn();
    secondOptions.lookup("media.example", {}, lookupCallback);
    expect(lookupCallback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("refreshes a completed task output and retries download without another paid POST", async () => {
    let downloadAttempt = 0;
    setAtlasPinnedDownloadForTest(async (url) => {
      downloadAttempt += 1;
      if (downloadAttempt === 1) {
        throw new VideoGenProviderError("Atlas Cloud video download was blocked or timed out.", 502);
      }
      expect(url).toBe("https://media.example/refreshed.mp4");
      return Buffer.from("video");
    });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/generateVideo")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ code: 0, data: {
          id: "prediction-refresh", status: "completed",
          outputs: ["https://media.example/original.mp4"],
        } }));
      }
      if (url.endsWith("/prediction/prediction-refresh")) {
        expect(init?.method).toBe("GET");
        return new Response(JSON.stringify({ code: 0, data: {
          id: "prediction-refresh", status: "completed",
          outputs: ["https://media.example/refreshed.mp4"],
        } }));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithAtlasCloud(input, "secret")).resolves.toMatchObject({
      providerTaskId: "prediction-refresh",
    });
    expect(downloadAttempt).toBe(2);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("makes no HTTPS request when public-host resolution rejects", async () => {
    const transport = fakeHttpsRequest(200);
    const resolveHost = vi.fn(async () => {
      throw new Error("private address");
    });

    await expect(pinnedDownload(
      "https://private.example/video.mp4",
      pinnedDependencies(transport.factory, { resolveHost }),
    )).rejects.toMatchObject({ status: 502 });
    expect(transport.factory).not.toHaveBeenCalled();
  });

  it("rejects redirects without following them", async () => {
    const transport = fakeHttpsRequest(302);
    await expect(pinnedDownload(
      "https://media.example/redirect",
      pinnedDependencies(transport.factory),
    )).rejects.toThrow("redirect/error is not allowed");
    expect(transport.factory).toHaveBeenCalledTimes(1);
    expect(transport.response.destroy).toHaveBeenCalledOnce();
  });

  it("rejects non-2xx download responses", async () => {
    const transport = fakeHttpsRequest(404);
    await expect(pinnedDownload(
      "https://media.example/missing",
      pinnedDependencies(transport.factory),
    )).rejects.toThrow("redirect/error is not allowed");
    expect(transport.response.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the request and rejects when the response body stalls", async () => {
    vi.useFakeTimers();
    const transport = fakeHttpsRequest(200);
    const download = pinnedDownload(
      "https://media.example/stalled",
      pinnedDependencies(transport.factory, { deadlineMs: 25 }),
    );
    const rejection = expect(download).rejects.toThrow("blocked or timed out");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(transport.request.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the request and response when the byte cap is exceeded", async () => {
    const transport = fakeHttpsRequest(200, (response) => {
      response.emit("data", Buffer.from("four"));
    });
    await expect(pinnedDownload(
      "https://media.example/large",
      pinnedDependencies(transport.factory, { maxBytes: 3 }),
    )).rejects.toThrow("exceeds the 250 MiB download limit");
    expect(transport.request.destroy).toHaveBeenCalledOnce();
    expect(transport.response.destroy).toHaveBeenCalledOnce();
  });
});