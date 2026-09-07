import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../webFetch", () => ({
  assertPublicHost: vi.fn(async () => {}),
}));

import { assertPublicHost } from "../../webFetch";
import {
  BYTEPLUS_SEEDANCE_25_MODEL,
  bytePlusRequestBody,
  generateWithBytePlusModelArk,
  safeBytePlusMediaUrl,
} from "./byteplus";
import type { VideoGenInput } from "../types";

const input: VideoGenInput = {
  prompt: "A presenter speaks naturally",
  aspectRatio: "9:16",
  durationSec: 8,
  resolution: "720p",
  generateAudio: true,
  model: BYTEPLUS_SEEDANCE_25_MODEL,
};

describe("BytePlus ModelArk Seedance 2.5", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds the official structured content task contract", () => {
    const body = bytePlusRequestBody({
      ...input,
      image: { buffer: Buffer.from("still"), mimeType: "image/png" },
      endImage: { buffer: Buffer.from("last"), mimeType: "image/jpeg" },
    });
    expect(body).toMatchObject({
      model: "dreamina-seedance-2-5-260628",
      generate_audio: true,
      duration: 8,
      resolution: "720p",
      content: [
        { type: "text" },
        {
          type: "image_url",
          role: "first_frame",
          image_url: { url: "data:image/png;base64,c3RpbGw=" },
        },
        {
          type: "image_url",
          role: "last_frame",
          image_url: { url: "data:image/jpeg;base64,bGFzdA==" },
        },
      ],
    });
    expect(body).not.toHaveProperty("ratio");
    expect(String((body.content as Array<{ text?: string }>)[0]?.text))
      .toContain("A presenter speaks naturally");
  });

  it("sends an explicit ratio only for text-to-video generation", () => {
    expect(bytePlusRequestBody(input)).toMatchObject({ ratio: "9:16" });
  });

  it("persists accepted task diagnostics and returns them without output URLs", async () => {
    const onProviderTaskAccepted = vi.fn(async () => {});
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v3/contents/generations/tasks")) {
        return new Response(JSON.stringify({
          id: "task-1",
          status: "succeeded",
          content: { video_url: "https://media.example.com/result.mp4" },
        }), { headers: { "x-request-id": "request-accepted-1" } });
      }
      if (url === "https://media.example.com/result.mp4") return new Response("video-bytes");
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const result = await generateWithBytePlusModelArk(
      { ...input, onProviderTaskAccepted },
      "ark-secret",
    );

    expect(result).toMatchObject({
      provider: "byteplus",
      model: "dreamina-seedance-2-5-260628",
      effectiveDurationSec: 8,
      providerTaskId: "task-1",
      providerRequestId: "request-accepted-1",
    });
    expect(onProviderTaskAccepted).toHaveBeenCalledWith({
      taskId: "task-1",
      requestId: "request-accepted-1",
    });
    expect(result).not.toHaveProperty("outputUrl");
    expect(result.buffer.toString()).toBe("video-bytes");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer ark-secret",
        "Content-Type": "application/json",
      },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe("https://media.example.com/result.mp4");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("polls an async pending task until it succeeds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v3/contents/generations/tasks")) {
        return new Response(JSON.stringify({ id: "task-pending", status: "queued" }));
      }
      if (url.endsWith("/tasks/task-pending")) {
        return new Response(JSON.stringify({
          id: "task-pending",
          status: "succeeded",
          content: { video_url: "https://media.example.com/polled.mp4" },
        }));
      }
      if (url === "https://media.example.com/polled.mp4") return new Response("polled-video");
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const generation = generateWithBytePlusModelArk(input, "ark-secret");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(generation).resolves.toMatchObject({ provider: "byteplus" });
    expect(fetch.mock.calls.map(([url]) => url)).toContain(
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/task-pending",
    );
  });

  it("surfaces a terminal failed task without attempting download", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "task-failed",
      status: "failed",
      error: "prompt rejected",
    }), { headers: { "x-request-id": "request-terminal-1" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithBytePlusModelArk(input, "ark-secret"))
      .rejects.toMatchObject({
        message: "BytePlus ModelArk generation did not succeed: prompt rejected",
        providerTaskId: "task-failed",
        requestId: "request-terminal-1",
      });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed task-creation POST without an idempotency contract", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response("upstream unavailable", {
        status: 503,
        headers: { "x-request-id": "request-rejected-1" },
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithBytePlusModelArk(input, "ark-secret"))
      .rejects.toMatchObject({
        name: "VideoGenProviderError",
        status: 503,
        requestId: "request-rejected-1",
      });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("resumes an accepted task without repeating the paid creation call", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      if (url.endsWith("/tasks/task-existing")) {
        return new Response(JSON.stringify({
          id: "task-existing",
          status: "succeeded",
          content: { video_url: "https://media.example.com/resumed.mp4" },
        }), { headers: { "x-request-id": "request-resumed-1" } });
      }
      if (url === "https://media.example.com/resumed.mp4") return new Response("resumed");
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const generation = generateWithBytePlusModelArk(
      { ...input, providerTaskId: "task-existing" },
      "ark-secret",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await expect(generation).resolves.toMatchObject({
      providerTaskId: "task-existing",
      providerRequestId: "request-resumed-1",
    });
    expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("retains accepted identifiers when the durable checkpoint write fails", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "task-checkpoint-failed",
      status: "queued",
    }), { headers: { "x-request-id": "request-checkpoint-failed" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithBytePlusModelArk({
      ...input,
      onProviderTaskAccepted: async () => {
        throw new Error("database unavailable");
      },
    }, "ark-secret")).rejects.toMatchObject({
      status: 503,
      providerTaskId: "task-checkpoint-failed",
      requestId: "request-checkpoint-failed",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a create response body that stalls after headers", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let requestSignal: AbortSignal | undefined;
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        // Deliberately never enqueue or close.
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(stalled);
    });
    vi.stubGlobal("fetch", fetch);

    const generation = generateWithBytePlusModelArk(input, "ark-secret");
    const assertion = expect(generation)
      .rejects.toThrow("Video provider call timed out after 120s");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("rejects a redirect to a private host before following it", async () => {
    vi.mocked(assertPublicHost).mockImplementation(async (hostname) => {
      if (hostname === "private.example") throw new Error("private");
    });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v3/contents/generations/tasks")) {
        return new Response(JSON.stringify({
          id: "redirect-task",
          status: "succeeded",
          content: { video_url: "https://media.example.com/source.mp4" },
        }));
      }
      if (url === "https://media.example.com/source.mp4") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example/video.mp4" },
        });
      }
      throw new Error(`private redirect was followed: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithBytePlusModelArk(input, "ark-secret"))
      .rejects.toThrow(/blocked or private host/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a video whose declared size exceeds the download limit", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/v3/contents/generations/tasks")) {
        return new Response(JSON.stringify({
          id: "large-task",
          status: "succeeded",
          content: { video_url: "https://media.example.com/large.mp4" },
        }));
      }
      if (url === "https://media.example.com/large.mp4") {
        return new Response("small body", {
          headers: { "content-length": String(250 * 1024 * 1024 + 1) },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithBytePlusModelArk(input, "ark-secret"))
      .rejects.toThrow(/exceeds the 250 MiB download limit/);
  });

  it("rejects non-HTTPS provider output URLs before download", async () => {
    await expect(safeBytePlusMediaUrl("http://media.example.com/result.mp4"))
      .rejects.toMatchObject({ name: "VideoGenProviderError", status: 502 });
  });

  it("refuses model aliases instead of mapping through another provider", async () => {
    await expect(generateWithBytePlusModelArk(
      { ...input, model: "bytedance/seedance-2.5" },
      "ark-secret",
    )).rejects.toMatchObject({ name: "VideoGenProviderError", status: 400 });
  });
});