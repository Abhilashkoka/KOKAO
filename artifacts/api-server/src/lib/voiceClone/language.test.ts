import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => platformFetchMock.mockReset());

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
    });
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
});