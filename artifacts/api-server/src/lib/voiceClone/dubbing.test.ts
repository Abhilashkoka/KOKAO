import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ElevenLabsDubbingError,
  elevenLabsDubSourceVoice,
} from "./index";

describe("elevenLabsDubSourceVoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates, polls, and downloads a clean single-speaker dub without leaking the key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ dubbing_id: "dub-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "dubbed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("dubbed-media"), {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      }) as unknown as typeof setTimeout,
    );

    const output = await elevenLabsDubSourceVoice({
      apiKey: "secret-elevenlabs-key",
      videoBytes: Buffer.from("source-video"),
      videoMime: "video/mp4",
      targetLang: "ta",
    });

    expect(output.toString()).toBe("dubbed-media");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toBe("https://api.elevenlabs.io/v1/dubbing");
    expect(String(createUrl)).not.toContain("secret-elevenlabs-key");
    expect(new Headers(createInit?.headers).get("xi-api-key")).toBe(
      "secret-elevenlabs-key",
    );
    const form = createInit?.body as FormData;
    expect(form.get("target_lang")).toBe("ta");
    expect(form.get("mode")).toBe("automatic");
    expect(form.get("num_speakers")).toBe("1");
    expect(form.get("drop_background_audio")).toBe("true");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(String(fetchMock.mock.calls[1]![0]).endsWith("/v1/dubbing/dub-123")).toBe(true);
    expect(
      String(fetchMock.mock.calls[2]![0]).endsWith(
        "/v1/dubbing/dub-123/audio/ta",
      ),
    ).toBe(true);
  });

  it("fails explicitly when ElevenLabs does not return a dubbing id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      elevenLabsDubSourceVoice({
        apiKey: "test-key",
        videoBytes: Buffer.from("source-video"),
        videoMime: "video/mp4",
        targetLang: "hi",
      }),
    ).rejects.toBeInstanceOf(ElevenLabsDubbingError);
  });
});