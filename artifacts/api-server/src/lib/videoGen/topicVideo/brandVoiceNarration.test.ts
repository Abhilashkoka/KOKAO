import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetProviderHealthForTests } from "../../providerHealth";
import { buildWav, synthesizeNarration } from "./narration";
import { VoiceCloneError, VoiceCloneNotConfiguredError } from "../../voiceClone";

vi.mock("@workspace/integrations-openai-ai-server/audio", () => ({
  textToSpeech: vi.fn(),
}));

vi.mock("../../voiceClone", async () => {
  const actual = await vi.importActual<typeof import("../../voiceClone")>("../../voiceClone");
  return { ...actual, speakWithClonedVoice: vi.fn() };
});

import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { speakWithClonedVoice } from "../../voiceClone";

const brandSpeak = vi.mocked(speakWithClonedVoice);
const stockSpeak = vi.mocked(textToSpeech);

/** Mono pcm16 WAV of the given length. */
function wav(durationSec: number, sampleRate = 24_000): Buffer {
  const byteRate = sampleRate * 2;
  return buildWav(
    { channels: 1, sampleRate, bitsPerSample: 16, byteRate, blockAlign: 2 },
    Buffer.alloc(Math.round(byteRate * durationSec)),
  );
}

const CLONED = { provider: "elevenlabs", voiceId: "el-brand-1" };
const SENTENCES = ["First sentence.", "Second sentence."];

describe("resolveNarrationVoice", () => {
  it("prefers the kit's preset voice when the job carries no explicit voice", async () => {
    const { resolveNarrationVoice } = await import("./narration");
    expect(resolveNarrationVoice(undefined, "nova")).toBe("nova");
    expect(resolveNarrationVoice(null, "shimmer")).toBe("shimmer");
  });

  it("lets an explicit job voice override the kit preset", async () => {
    const { resolveNarrationVoice } = await import("./narration");
    expect(resolveNarrationVoice("echo", "nova")).toBe("echo");
  });

  it("falls back to the default narrator only when neither is set or valid", async () => {
    const { resolveNarrationVoice } = await import("./narration");
    expect(resolveNarrationVoice(undefined, undefined)).toBe("alloy");
    expect(resolveNarrationVoice("not-a-voice", "also-bad")).toBe("alloy");
  });
});

describe("synthesizeNarration with a cloned brand voice", () => {
  beforeEach(() => {
    brandSpeak.mockReset();
    stockSpeak.mockReset();
    resetProviderHealthForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("speaks the whole track in the brand voice, never touching stock TTS", async () => {
    brandSpeak.mockResolvedValue(wav(1));

    const narration = await synthesizeNarration(SENTENCES, "alloy", { clonedVoice: CLONED });

    expect(brandSpeak).toHaveBeenCalledTimes(SENTENCES.length);
    expect(brandSpeak).toHaveBeenCalledWith(CLONED, "First sentence.");
    expect(stockSpeak).not.toHaveBeenCalled();
    expect(narration.cues).toHaveLength(2);
    expect(narration.totalDurationSec).toBeGreaterThan(2);
  });

  it("falls back to the stock voices for the ENTIRE track when the brand voice fails", async () => {
    // First sentence speaks fine, second dies: nothing from the brand voice
    // may survive — the whole track must be re-spoken on stock TTS.
    brandSpeak.mockResolvedValueOnce(wav(1)).mockRejectedValue(
      new VoiceCloneError("provider down", 503),
    );
    stockSpeak.mockResolvedValue(wav(1));

    const narration = await synthesizeNarration(SENTENCES, "nova", { clonedVoice: CLONED });

    expect(stockSpeak).toHaveBeenCalledTimes(SENTENCES.length);
    expect(narration.cues).toHaveLength(2);
  });

  it("falls back when voice cloning is not configured at all", async () => {
    brandSpeak.mockRejectedValue(new VoiceCloneNotConfiguredError());
    stockSpeak.mockResolvedValue(wav(1));

    const narration = await synthesizeNarration(SENTENCES, "alloy", { clonedVoice: CLONED });

    expect(stockSpeak).toHaveBeenCalledTimes(SENTENCES.length);
    expect(narration.cues).toHaveLength(2);
  });

  it("uses stock voices directly when no cloned voice is supplied", async () => {
    stockSpeak.mockResolvedValue(wav(1));

    await synthesizeNarration(SENTENCES, "alloy");

    expect(brandSpeak).not.toHaveBeenCalled();
    expect(stockSpeak).toHaveBeenCalledTimes(SENTENCES.length);
  });
});
