import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable } from "@workspace/db";
import {
  getProviderHealth,
  recordProviderFailure,
  resetProviderHealthForTests,
} from "../../providerHealth";
import { VideoGenProviderError } from "../types";
import { orderedTtsProviders, resolveTtsApiKey, TTS_PROVIDERS } from "./tts";
import { buildWav, synthesizeNarration } from "./narration";

vi.mock("@workspace/integrations-openai-ai-server/audio", () => ({
  textToSpeech: vi.fn(),
}));

import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";

const savedKey = process.env.DEEPGRAM_API_KEY;
const realFetch = globalThis.fetch;

/** Mono pcm16 WAV of the given length, matching what both providers return. */
function wav(durationSec: number, sampleRate = 24_000): Buffer {
  const byteRate = sampleRate * 2;
  return buildWav(
    { channels: 1, sampleRate, bitsPerSample: 16, byteRate, blockAlign: 2 },
    Buffer.alloc(Math.round(byteRate * durationSec)),
  );
}

function okAudio(buffer: Buffer): Response {
  return { ok: true, status: 200, arrayBuffer: async () => buffer } as unknown as Response;
}

describe("tts provider registry", () => {
  beforeEach(async () => {
    vi.mocked(textToSpeech).mockReset();
    resetProviderHealthForTests();
    delete process.env.DEEPGRAM_API_KEY;
    // A stored Deepgram ASR key doubles as the TTS key; clear it for determinism.
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "asr_%"));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = savedKey;
  });

  it("offers the built-in provider with no key configured", async () => {
    const ordered = await orderedTtsProviders();
    expect(ordered.map((p) => p.id)).toEqual(["openai"]);
  });

  it("adds Deepgram once its key is available, built-in still first", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    const ordered = await orderedTtsProviders();
    expect(ordered.map((p) => p.id)).toEqual(["openai", "deepgram"]);
  });

  it("puts Deepgram first when the built-in provider's breaker is open", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    for (let i = 0; i < 3; i++) recordProviderFailure("tts:openai");
    const ordered = await orderedTtsProviders();
    expect(ordered.map((p) => p.id)).toEqual(["deepgram", "openai"]);
  });

  it("reuses the stored Deepgram speech-to-text key", async () => {
    const { setStoredAsrKey } = await import("../../asr");
    await setStoredAsrKey("deepgram", "stored-dg-key");
    const def = TTS_PROVIDERS.find((p) => p.id === "deepgram")!;
    expect(await resolveTtsApiKey(def)).toBe("stored-dg-key");
  });

  it("asks Deepgram for WAV bytes the narration parser can read", async () => {
    const fetchMock = vi.fn(async () => okAudio(wav(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const def = TTS_PROVIDERS.find((p) => p.id === "deepgram")!;

    await def.speak("Hello there.", "nova", "test-dg-key");

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(params.get("model")).toBe("aura-asteria-en");
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("container")).toBe("wav");
    expect(params.get("sample_rate")).toBe("24000");
    expect((init.headers as Record<string, string>).Authorization).toBe("Token test-dg-key");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello there." });
  });

  it("surfaces a Deepgram HTTP failure as a provider error with its status", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "upstream unavailable",
    })) as unknown as typeof fetch;
    const def = TTS_PROVIDERS.find((p) => p.id === "deepgram")!;

    await expect(def.speak("Hi.", "alloy", "test-dg-key")).rejects.toMatchObject({
      name: "VideoGenProviderError",
      status: 503,
    });
  });

  it("refuses to speak without a key rather than calling Deepgram anonymously", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const def = TTS_PROVIDERS.find((p) => p.id === "deepgram")!;

    await expect(def.speak("Hi.", "alloy", null)).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("synthesizeNarration provider failover", () => {
  beforeEach(async () => {
    vi.mocked(textToSpeech).mockReset();
    resetProviderHealthForTests();
    delete process.env.DEEPGRAM_API_KEY;
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "asr_%"));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = savedKey;
  });

  it("re-speaks the whole track on the fallback provider", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    vi.mocked(textToSpeech).mockRejectedValue(new VideoGenProviderError("voice down", 503));
    const fetchMock = vi.fn(async () => okAudio(wav(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await synthesizeNarration(["First line.", "Second line."], "nova");

    // Both sentences came from Deepgram — a mixed track would be rejected.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.cues).toHaveLength(2);
    expect(out.totalDurationSec).toBeCloseTo(1 + 0.25 + 1 + 0.6, 2);
    expect(getProviderHealth("tts:openai")?.consecutiveFailures).toBe(1);
    expect(getProviderHealth("tts:deepgram")?.consecutiveFailures).toBe(0);
  }, 20_000);

  it("fails without a fallback when nothing else is configured", async () => {
    vi.mocked(textToSpeech).mockRejectedValue(new VideoGenProviderError("voice down", 503));

    await expect(synthesizeNarration(["Only line."], "alloy")).rejects.toThrow("voice down");
  }, 20_000);

  it("does not re-speak the track on a permanent failure", async () => {
    process.env.DEEPGRAM_API_KEY = "test-dg-key";
    vi.mocked(textToSpeech).mockRejectedValue(
      new VideoGenProviderError("that text cannot be spoken", 400),
    );
    const fetchMock = vi.fn(async () => okAudio(wav(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(synthesizeNarration(["Only line."], "alloy")).rejects.toThrow("cannot be spoken");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProviderHealth("tts:openai")).toBeNull();
  });

  it("rejects a track whose sentences came back in different formats", async () => {
    vi.mocked(textToSpeech)
      .mockResolvedValueOnce(wav(1, 24_000))
      .mockResolvedValueOnce(wav(1, 16_000));

    await expect(synthesizeNarration(["One.", "Two."], "alloy")).rejects.toThrow(
      "inconsistent audio formats",
    );
  });

  it("refuses an empty script before reaching any provider", async () => {
    await expect(synthesizeNarration([], "alloy")).rejects.toThrow("no narration to speak");
    expect(textToSpeech).not.toHaveBeenCalled();
  });
});
