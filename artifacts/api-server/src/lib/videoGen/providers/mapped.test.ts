import { describe, it, expect, vi, afterEach } from "vitest";
import { generateWithMappedVideo, getAtPath, setAtPath } from "./mapped";
import { VideoGenNotConfiguredError, VideoGenProviderError } from "../types";
import type { VideoGenInput } from "../types";
import type { CustomVideoApiMapping } from "@workspace/db";

/**
 * The mapped adapter talks to the provider via global fetch (through
 * boundedProviderFetch), so tests stub fetch and assert the exact requests
 * built from the admin-configured mapping.
 */

const baseInput: VideoGenInput = {
  prompt: "A barista pulling an espresso shot",
  aspectRatio: "9:16",
  durationSec: 6,
  model: "acme/video-1",
};

const asyncMapping: CustomVideoApiMapping = {
  template: "custom",
  submitPath: "/v2/generate",
  pollPath: "/v2/jobs/{id}",
  promptField: "input.text",
  modelField: "model_name",
  durationField: "seconds",
  aspectRatioField: "input.aspect",
  imageField: "input.start_image",
  jobIdPath: "job.id",
  statusPath: "job.state",
  pendingValues: ["working"],
  completedValue: "done",
  videoUrlPath: "job.result.urls",
  errorPath: "job.failure_reason",
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

const opts = { baseUrl: "https://api.acme.dev", label: "Acme", mapping: asyncMapping };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("path helpers", () => {
  it("gets nested and array-indexed values", () => {
    expect(getAtPath({ a: { b: [{ url: "x" }] } }, "a.b.0.url")).toBe("x");
    expect(getAtPath({ a: 1 }, "a.b")).toBeUndefined();
  });

  it("sets nested paths, creating intermediate objects", () => {
    const body: Record<string, unknown> = {};
    setAtPath(body, "input.text", "hello");
    setAtPath(body, "input.aspect", "1:1");
    expect(body).toEqual({ input: { text: "hello", aspect: "1:1" } });
  });
});

describe("generateWithMappedVideo", () => {
  it("throws NotConfigured without a key (never reaches the network)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(generateWithMappedVideo(baseInput, null, opts)).rejects.toBeInstanceOf(
      VideoGenNotConfiguredError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws NotConfigured with a clear message on an incomplete mapping", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      generateWithMappedVideo(baseInput, "sk-x", {
        ...opts,
        mapping: { template: "custom", submitPath: "/v2/generate" },
      }),
    ).rejects.toThrow(/incomplete video API mapping/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps request fields, polls with the mapped status, and downloads the clip", async () => {
    const clip = new Uint8Array([9, 8, 7]);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ job: { id: "j-77", state: "working" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          job: { id: "j-77", state: "done", result: { urls: ["https://cdn.acme.dev/v.mp4"] } },
        }),
      )
      .mockResolvedValueOnce(videoResponse(clip));
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();

    const promise = generateWithMappedVideo(baseInput, "sk-acme", opts);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;
    expect(result.provider).toBe("custom");
    expect(result.model).toBe("acme/video-1");
    expect([...result.buffer]).toEqual([9, 8, 7]);

    const [submitUrl, submitInit] = fetchSpy.mock.calls[0]!;
    expect(submitUrl).toBe("https://api.acme.dev/v2/generate");
    const body = JSON.parse((submitInit as RequestInit).body as string);
    expect(body.model_name).toBe("acme/video-1");
    expect(body.seconds).toBe(6);
    expect(body.input.aspect).toBe("9:16");
    expect(body.input.text).toContain("A barista pulling an espresso shot");
    expect(body.input.start_image).toBeUndefined();
    expect((submitInit as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-acme",
    });
    expect(fetchSpy.mock.calls[1]![0]).toBe("https://api.acme.dev/v2/jobs/j-77");
    expect(fetchSpy.mock.calls[2]![0]).toBe("https://cdn.acme.dev/v.mp4");
  });

  it("supports synchronous APIs (no poll path)", async () => {
    const clip = new Uint8Array([1]);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ job: { result: { urls: "https://cdn.acme.dev/s.mp4" } } }))
      .mockResolvedValueOnce(videoResponse(clip));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await generateWithMappedVideo(baseInput, "sk-acme", {
      ...opts,
      mapping: { ...asyncMapping, pollPath: undefined, jobIdPath: undefined, statusPath: undefined },
    });
    expect([...result.buffer]).toEqual([1]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends the start image as a data URL at the mapped field", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          job: { id: 42, state: "done", result: { urls: ["https://cdn.acme.dev/i.mp4"] } },
        }),
      )
      .mockResolvedValueOnce(videoResponse(new Uint8Array([2])));
    vi.stubGlobal("fetch", fetchSpy);
    await generateWithMappedVideo(
      { ...baseInput, image: { buffer: Buffer.from("png-bytes"), mimeType: "image/png" } },
      "sk-acme",
      opts,
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.input.start_image).toBe(
      `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
    );
  });

  it("fails image-to-video clearly when the mapping has no image field", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      generateWithMappedVideo(
        { ...baseInput, image: { buffer: Buffer.from("x"), mimeType: "image/png" } },
        "sk-acme",
        { ...opts, mapping: { ...asyncMapping, imageField: undefined } },
      ),
    ).rejects.toThrow(/no image field/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the mapped error detail when the job fails", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      jsonResponse({ job: { id: "j-1", state: "failed", failure_reason: "nsfw prompt" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(generateWithMappedVideo(baseInput, "sk-acme", opts)).rejects.toThrow(
      /did not complete: nsfw prompt/,
    );
  });

  it("throws a clear error when the video URL path finds nothing", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ job: { id: "j-1", state: "done", result: {} } }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(generateWithMappedVideo(baseInput, "sk-acme", opts)).rejects.toThrow(
      /no video URL at "job.result.urls"/,
    );
  });

  it("propagates non-2xx submits as provider errors with the status", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ error: "bad" }, 400));
    vi.stubGlobal("fetch", fetchSpy);
    const err = await generateWithMappedVideo(baseInput, "sk-acme", opts).catch((e) => e);
    expect(err).toBeInstanceOf(VideoGenProviderError);
    expect(err.status).toBe(400);
  });
});
