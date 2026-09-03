import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateWithHiggsfield,
  HIGGSFIELD_IMAGE_MODEL,
  higgsfieldImageRequestBody,
  higgsfieldImageTerminalState,
} from "./higgsfield";

vi.mock("../../webFetch", () => ({
  assertPublicHost: vi.fn(async () => {}),
}));

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Higgsfield image generation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("uses Soul v2 Standard and asks for the requested composition", () => {
    expect(HIGGSFIELD_IMAGE_MODEL).toBe("higgsfield-ai/soul/v2/standard");
    expect(
      higgsfieldImageRequestBody({
        prompt: "Editorial product shot",
        size: "1024x1536",
        model: HIGGSFIELD_IMAGE_MODEL,
      }),
    ).toEqual({
      prompt: "Editorial product shot\n\nCompose the final image in a portrait 2:3 aspect ratio.",
    });
  });

  it("recognizes the documented terminal states", () => {
    expect(higgsfieldImageTerminalState("completed")).toBe("done");
    expect(higgsfieldImageTerminalState("NSFW")).toBe("failed");
    expect(higgsfieldImageTerminalState("failed")).toBe("failed");
    expect(higgsfieldImageTerminalState("in_progress")).toBeNull();
  });

  it("submits, polls, and downloads the completed image", async () => {
    const output = Buffer.from("image-bytes");
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(json({
        status: "queued",
        request_id: "request-1",
        status_url: "https://api.higgsfield.ai/requests/request-1/status",
      }))
      .mockResolvedValueOnce(json({
        status: "completed",
        request_id: "request-1",
        images: [{ url: "https://cdn.higgsfield.ai/result.png" }],
      }))
      .mockResolvedValueOnce(new Response(output, { status: 200 }));

    const promise = generateWithHiggsfield(
      {
        prompt: "A campaign image",
        size: "1024x1024",
        model: HIGGSFIELD_IMAGE_MODEL,
      },
      "id:secret",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result.buffer).toEqual(output);
    expect(result.provider).toBe("higgsfield");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Key id:secret" }),
      }),
    );
  });

  it("fails clearly when the provider rejects the request", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(json({ detail: "Invalid credentials" }, 401));
    await expect(
      generateWithHiggsfield(
        {
          prompt: "A campaign image",
          size: "1024x1024",
          model: HIGGSFIELD_IMAGE_MODEL,
        },
        "bad",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});