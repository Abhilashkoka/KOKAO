import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, appCredentialsTable } from "@workspace/db";
import { generateMusicBed, MUSICGEN_VERSION } from "./musicGen";
import { VideoGenNotConfiguredError } from "./types";

const meterMock = vi.hoisted(() => vi.fn(
  async (_ctx: unknown, _key: unknown, _quantity: unknown, run: () => Promise<unknown>) => run(),
));
vi.mock("../meter", () => ({ meter: meterMock }));

const realFetch = globalThis.fetch;
const savedToken = process.env.REPLICATE_API_TOKEN;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generateMusicBed", () => {
  beforeEach(async () => {
    globalThis.fetch = vi.fn();
    meterMock.mockClear();
    delete process.env.REPLICATE_API_TOKEN;
    await db
      .delete(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "videogen_replicate"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = savedToken;
  });

  it("fails with a clear message when Replicate is not configured", async () => {
    await expect(generateMusicBed("lofi beat", 30, null)).rejects.toThrow(VideoGenNotConfiguredError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("creates a prediction, waits, and downloads the audio", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    const audio = Buffer.from("mp3-bytes-here");
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("api.replicate.com")) {
        return jsonResponse({
          status: "succeeded",
          output: "https://replicate.delivery/out.mp3",
        });
      }
      return new Response(new Uint8Array(audio), { status: 200 });
    });

    const out = await generateMusicBed("warm lofi chill beat", 22, {
      tenantId: 42,
      refKind: "videoJob",
      refId: "88",
      operationKey: "videoJob:88:music",
    });
    expect(out.equals(audio)).toBe(true);

    const createCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(createCall[0])).toBe("https://api.replicate.com/v1/predictions");
    const body = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(body.version).toBe(MUSICGEN_VERSION);
    expect(body.input.duration).toBe(22);
    expect(body.input.prompt).toContain("warm lofi chill beat");
    expect(body.input.prompt).toContain("no vocals");
    expect(meterMock.mock.calls[0]?.slice(0, 3)).toEqual([
      {
        tenantId: 42, refKind: "videoJob", refId: "88",
        provider: "replicate", model: "meta/musicgen",
        operationFamilyKey: "videoJob:88:music",
        operationKey:
          "videoJob:88:music:provider:replicate:model:meta/musicgen:attempt:0",
      },
      "video",
      22,
    ]);
  });

  it("clamps the requested duration to MusicGen's 30s ceiling", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    vi.mocked(globalThis.fetch).mockImplementation(async (url) =>
      String(url).includes("api.replicate.com")
        ? jsonResponse({ status: "succeeded", output: ["https://replicate.delivery/out.mp3"] })
        : new Response(new Uint8Array(Buffer.from("x")), { status: 200 }),
    );
    await generateMusicBed("epic cinematic", 95, null);
    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.input.duration).toBe(30);
  });

  it("surfaces a failed prediction as a provider error", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token";
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse({ status: "failed", error: "NSFW prompt" }),
    );
    await expect(generateMusicBed("x", 10, null)).rejects.toThrow(/did not succeed/);
  });
});
