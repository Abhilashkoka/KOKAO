import { describe, it, expect, vi, afterEach } from "vitest";
import { generateWithOpenRouterVideo } from "./openrouter";
import { VideoGenNotConfiguredError, VideoGenProviderError } from "../types";
import type { VideoGenInput } from "../types";

/**
 * The provider talks to OpenRouter through global fetch (via
 * boundedProviderFetch), so tests stub fetch and assert the exact requests:
 * the async /videos submit, the poll, and the clip download.
 */

const baseInput: VideoGenInput = {
  prompt: "A barista pulling an espresso shot",
  aspectRatio: "9:16",
  durationSec: 6,
  model: "kwaivgi/kling-v3.0-std",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function videoResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateWithOpenRouterVideo", () => {
  it("throws NotConfigured without a key (never reaches the network)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(generateWithOpenRouterVideo(baseInput, null)).rejects.toBeInstanceOf(
      VideoGenNotConfiguredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits, then downloads the clip from unsigned_urls when the job completes", async () => {
    const clip = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = vi
      .fn()
      // Submit: job comes back already terminal, so no poll round is needed.
      .mockResolvedValueOnce(
        jsonResponse({
          id: "job-1",
          status: "completed",
          unsigned_urls: ["https://videos.example/clip.mp4"],
        }),
      )
      .mockResolvedValueOnce(videoResponse(clip));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await generateWithOpenRouterVideo(baseInput, "sk-or-key");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("kwaivgi/kling-v3.0-std");
    expect([...result.buffer]).toEqual([1, 2, 3, 4]);

    const [submitUrl, submitInit] = fetchSpy.mock.calls[0]!;
    expect(submitUrl).toBe("https://openrouter.ai/api/v1/videos");
    const body = JSON.parse((submitInit as RequestInit).body as string);
    expect(body.model).toBe("kwaivgi/kling-v3.0-std");
    expect(body.aspect_ratio).toBe("9:16");
    expect(body.duration).toBe(6);
    expect(body.prompt).toContain("A barista pulling an espresso shot");
    expect(body.frame_images).toBeUndefined();
    expect((submitInit as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-or-key",
    });

    expect(fetchSpy.mock.calls[1]![0]).toBe("https://videos.example/clip.mp4");
    expect((fetchSpy.mock.calls[1]![1] as RequestInit).headers).toBeUndefined();
  });

  it("authenticates downloads that point back to the OpenRouter API", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "job-auth",
          status: "completed",
          unsigned_urls: [
            "https://openrouter.ai/api/v1/videos/job-auth/content?index=0",
          ],
        }),
      )
      .mockResolvedValueOnce(videoResponse(new Uint8Array([5, 6])));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await generateWithOpenRouterVideo(baseInput, "sk-or-key");

    expect([...result.buffer]).toEqual([5, 6]);
    expect(fetchSpy.mock.calls[1]![0]).toBe(
      "https://openrouter.ai/api/v1/videos/job-auth/content?index=0",
    );
    expect((fetchSpy.mock.calls[1]![1] as RequestInit).headers).toEqual({
      Authorization: "Bearer sk-or-key",
    });
  });

  it("falls back to the authenticated content endpoint when no URL is returned", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "job-content", status: "completed" }))
      .mockResolvedValueOnce(videoResponse(new Uint8Array([8])));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await generateWithOpenRouterVideo(baseInput, "sk-or-key");

    expect([...result.buffer]).toEqual([8]);
    expect(fetchSpy.mock.calls[1]![0]).toBe(
      "https://openrouter.ai/api/v1/videos/job-content/content?index=0",
    );
    expect((fetchSpy.mock.calls[1]![1] as RequestInit).headers).toEqual({
      Authorization: "Bearer sk-or-key",
    });
  });

  it("sends a start image as the first frame and snaps Veo durations", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ id: "job-2", status: "completed", unsigned_urls: ["https://v/x.mp4"] }),
      )
      .mockResolvedValueOnce(videoResponse(new Uint8Array([9])));
    vi.stubGlobal("fetch", fetchSpy);

    await generateWithOpenRouterVideo(
      {
        ...baseInput,
        model: "google/veo-3.1-fast",
        durationSec: 7, // Veo only supports 4/6/8 — snapped to 6.
        image: { buffer: Buffer.from("png-bytes"), mimeType: "image/png" },
      },
      "sk-or-key",
    );

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.duration).toBe(6);
    expect(body.frame_images).toEqual([
      {
        type: "image_url",
        frame_type: "first_frame",
        image_url: { url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` },
      },
    ]);
  });

  it("polls a pending job until it completes", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ id: "job-3", status: "pending", polling_url: "/api/v1/videos/job-3" }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: "job-3", status: "processing" }))
        .mockResolvedValueOnce(
          jsonResponse({ id: "job-3", status: "completed", unsigned_urls: ["https://v/c.mp4"] }),
        )
        .mockResolvedValueOnce(videoResponse(new Uint8Array([7])));
      vi.stubGlobal("fetch", fetchSpy);

      const pending = generateWithOpenRouterVideo(baseInput, "sk-or-key");
      // Two poll waits of 5s each before the job completes.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect([...result.buffer]).toEqual([7]);
      expect(fetchSpy.mock.calls[1]![0]).toBe("https://openrouter.ai/api/v1/videos/job-3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails with the job error when the upstream job does not complete", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ id: "job-4", status: "failed", error: "content policy" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(generateWithOpenRouterVideo(baseInput, "sk-or-key")).rejects.toThrow(
      /content policy/,
    );
  });

  it("wraps a submit rejection in a status-carrying provider error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ error: "bad request" }, 400));
    vi.stubGlobal("fetch", fetchSpy);
    const err = await generateWithOpenRouterVideo(baseInput, "sk-or-key").catch((e) => e);
    expect(err).toBeInstanceOf(VideoGenProviderError);
    expect((err as VideoGenProviderError).status).toBe(400);
    // 400s are terminal: no retry rounds.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
