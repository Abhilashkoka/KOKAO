import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../platformFetch", () => ({
  platformFetch: platformFetchMock,
  PlatformTimeoutError: class PlatformTimeoutError extends Error {},
}));

import {
  buildBrandVoiceTtsOperationKey,
  getVoiceCloneProviderDef,
} from "./index";

describe("ElevenLabs localized speech", () => {
  beforeEach(() => {
    platformFetchMock.mockReset();
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends exact Unicode text and explicit language_code", async () => {
    platformFetchMock.mockResolvedValue(
      new Response(new Uint8Array([0, 0]), {
        status: 200,
        headers: { "character-cost": "12" },
      }),
    );
    const def = getVoiceCloneProviderDef("elevenlabs")!;
    const text = "మనం ఇప్పుడు ప్రారంభిద్దాం.";
    await def.speakWithReceipt!({
      apiKey: "secret",
      voiceId: "voice-1",
      text,
      modelId: "eleven_v3",
      languageCode: "te",
    });
    const [, init] = platformFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text,
      model_id: "eleven_v3",
      language_code: "te",
      voice_settings: {
        stability: 0.5, similarity_boost: 0.9, style: 0, use_speaker_boost: true,
      },
    });
  });

  it("uses documented auto-detection instead of sending language_code to multilingual_v2", async () => {
    platformFetchMock.mockResolvedValue(
      new Response(new Uint8Array([0, 0]), { status: 200 }),
    );
    const def = getVoiceCloneProviderDef("elevenlabs")!;
    const text = "नमस्ते";
    await def.speakWithReceipt!({
      apiKey: "secret",
      voiceId: "voice-1",
      text,
      modelId: "eleven_multilingual_v2",
      languageCode: "hi",
    });
    const [, init] = platformFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.55, similarity_boost: 0.9, style: 0, use_speaker_boost: true,
      },
    });
  });

  it("sends accent settings and trimmed adjacent text while preserving the receipt", async () => {
    platformFetchMock.mockResolvedValue(
      new Response(new Uint8Array([0, 0]), {
        status: 200, headers: { "character-cost": "15", "request-id": "req-accent" },
      }),
    );
    const onReceipt = vi.fn();
    const result = await getVoiceCloneProviderDef("elevenlabs")!.speakWithReceipt!({
      apiKey: "test-key", voiceId: "voice-1", text: "Middle sentence.",
      context: { previousText: "  First sentence. ", nextText: " Last sentence.  " },
      onReceipt,
    });
    const body = JSON.parse(String(platformFetchMock.mock.calls[0][1].body));
    expect(body).toEqual({
      text: "Middle sentence.", model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.55, similarity_boost: 0.9, style: 0, use_speaker_boost: true,
      },
      previous_text: "First sentence.", next_text: "Last sentence.",
    });
    expect(result.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(result.receipt).toMatchObject({ providerCredits: "15", requestId: "req-accent" });
    expect(onReceipt).toHaveBeenCalledWith(result.receipt);
  });

  it("honours the optional model override, but explicit models still win", async () => {
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "eleven_v3");
    platformFetchMock.mockImplementation(async () =>
      new Response(new Uint8Array([0, 0]), { status: 200 }),
    );
    const def = getVoiceCloneProviderDef("elevenlabs")!;
    const args = {
      apiKey: "test-key", voiceId: "voice-1", text: "Hello.",
      context: { previousText: " ", nextText: "" },
    };
    await def.speak(args);
    let body = JSON.parse(String(platformFetchMock.mock.calls[0][1].body));
    expect(body.model_id).toBe("eleven_v3");
    expect(body.voice_settings.stability).toBe(0.5);
    expect(body).not.toHaveProperty("previous_text");
    expect(body).not.toHaveProperty("next_text");
    await def.speak({ ...args, modelId: "eleven_multilingual_v2" });
    body = JSON.parse(String(platformFetchMock.mock.calls[1][1].body));
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings.stability).toBe(0.55);
  });

  it("keeps locale in durable operation identity while preserving legacy keys", () => {
    const legacy = buildBrandVoiceTtsOperationKey("v", "m", "same");
    const telugu = buildBrandVoiceTtsOperationKey("v", "m", "same", undefined, "te");
    const tamil = buildBrandVoiceTtsOperationKey("v", "m", "same", undefined, "ta");
    expect(legacy).toContain("brand-voice-tts-v1:");
    expect(telugu).toContain("brand-voice-tts-v2:");
    expect(telugu).not.toBe(tamil);
    expect(telugu).not.toBe(legacy);
  });

  it("keeps job, cue, and stage scopes stable across retries", () => {
    const first = buildBrandVoiceTtsOperationKey(
      "v",
      "m",
      "same",
      { jobId: 17, cueIndex: 3, stage: "guided-narration" },
      "te",
    );
    const retry = buildBrandVoiceTtsOperationKey(
      "v",
      "m",
      "same",
      { jobId: 17, cueIndex: 3, stage: "guided-narration" },
      "te",
    );
    const otherJob = buildBrandVoiceTtsOperationKey(
      "v",
      "m",
      "same",
      { jobId: 18, cueIndex: 3, stage: "guided-narration" },
      "te",
    );
    const otherStage = buildBrandVoiceTtsOperationKey(
      "v",
      "m",
      "same",
      { jobId: 17, cueIndex: 3, stage: "dialogue-tts" },
      "te",
    );
    expect(first).toBe(retry);
    expect(first).not.toBe(otherJob);
    expect(first).not.toBe(otherStage);
  });
});