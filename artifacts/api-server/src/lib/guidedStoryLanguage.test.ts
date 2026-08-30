import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuidedStoryScript } from "@workspace/db";
import * as platformFetchModule from "./platformFetch";
import {
  buildBrandVoiceTtsOperationKey,
  getVoiceCloneProviderDef,
  resolveElevenLabsSpeechLanguage,
} from "./voiceClone";
import {
  guidedStoryNativeScriptWarning,
  guidedStoryNativeScriptInstruction,
  guidedStorySnapshotFingerprint,
  normalizeGuidedStoryLocale,
} from "./videoGen/guidedStory";

function spokenScript(text: string): GuidedStoryScript {
  return {
    version: 1,
    title: "Story",
    logline: "",
    runtimeSeconds: 1,
    warnings: [],
    roles: [{ id: "role-1", name: "Role", description: "Role" }],
    scenes: [{
      id: "scene-1",
      startMs: 0,
      endMs: 1000,
      visualDirection: "A room",
      roleIds: ["role-1"],
      lines: [{
        id: "line-1",
        ownerRoleId: "role-1",
        kind: "dialogue",
        text,
        startMs: 0,
        endMs: 1000,
      }],
    }],
  };
}

describe("Guided Story language identity", () => {
  it.each([
    ["te_IN", "te"],
    ["ta-in", "ta"],
    ["HI", "hi"],
    ["en-US", "en"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeGuidedStoryLocale(input)).toBe(expected);
  });

  it("rejects unsupported and ambiguous locales", () => {
    expect(normalizeGuidedStoryLocale("fr")).toBeNull();
    expect(normalizeGuidedStoryLocale("Indian")).toBeNull();
  });

  it.each([
    ["te", "ఇది తెలుగు కథ"],
    ["ta", "இது ஒரு தமிழ் கதை"],
    ["hi", "यह एक हिंदी कहानी है"],
    ["en", "This is an English story"],
  ])("accepts native %s spoken text", (locale, text) => {
    expect(guidedStoryNativeScriptWarning(spokenScript(text), locale)).toBeNull();
  });

  it("returns an actionable warning for Romanized local-language text", () => {
    const warning = guidedStoryNativeScriptWarning(
      spokenScript("Idi oka Telugu katha"),
      "te-IN",
    );
    expect(warning).toContain("Romanized");
    expect(warning).toContain("native Telugu script");
    expect(warning).toContain("Retry generation");
  });

  it("gives full generation and scene insertion a native-script contract", () => {
    expect(guidedStoryNativeScriptInstruction("te-IN"))
      .toMatch(/Telugu.*native Telugu script.*Do not Romanize/u);
    expect(guidedStoryNativeScriptInstruction("ta"))
      .toMatch(/Tamil.*native Tamil script.*Do not Romanize/u);
  });

  it("makes scene snapshot identity locale-sensitive", () => {
    const script = spokenScript("కథ");
    const common = { script, cast: [] };
    expect(guidedStorySnapshotFingerprint({ ...common, locale: "te-IN" }))
      .not.toBe(guidedStorySnapshotFingerprint({ ...common, locale: "ta-IN" }));
  });
});

describe("ElevenLabs localized speech", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the exact Unicode text and explicit language code through eleven_v3", async () => {
    const text = "ఇది తెలుగు కథ";
    const fetchSpy = vi.spyOn(platformFetchModule, "platformFetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "character-cost": "4" },
      }),
    );
    const provider = getVoiceCloneProviderDef("elevenlabs")!;
    await provider.speakWithReceipt!({
      apiKey: "test",
      voiceId: "voice",
      text,
      modelId: "eleven_v3",
      languageCode: "te",
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      text,
      model_id: "eleven_v3",
      language_code: "te",
    });
  });

  it("keeps multilingual v2 auto-detection and rejects Telugu before dispatch", async () => {
    const text = "यह हिंदी कहानी है";
    const fetchSpy = vi.spyOn(platformFetchModule, "platformFetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
    const provider = getVoiceCloneProviderDef("elevenlabs")!;
    await provider.speakWithReceipt!({
      apiKey: "test",
      voiceId: "voice",
      text,
      modelId: "eleven_multilingual_v2",
      languageCode: "hi-IN",
    });
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      text,
      model_id: "eleven_multilingual_v2",
    });
    await expect(provider.speakWithReceipt!({
      apiKey: "test", voiceId: "voice", text: "తెలుగు", modelId: "eleven_multilingual_v2", languageCode: "te",
    })).rejects.toThrow(/does not support Telugu/u);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("centralizes the model and locale capability policy", () => {
    expect(resolveElevenLabsSpeechLanguage("eleven_v3", "te-IN")).toEqual({
      modelId: "eleven_v3", languageCode: "te",
    });
    expect(resolveElevenLabsSpeechLanguage("eleven_multilingual_v2", "ta-IN")).toEqual({
      modelId: "eleven_multilingual_v2",
    });
    expect(() => resolveElevenLabsSpeechLanguage("eleven_multilingual_v2", "te-IN"))
      .toThrow(/Use eleven_v3/u);
  });

  it("includes locale in durable operation identity without changing legacy keys", () => {
    process.env.SESSION_SECRET = "test-secret";
    const te = buildBrandVoiceTtsOperationKey("voice", "model", "text", undefined, "te");
    const ta = buildBrandVoiceTtsOperationKey("voice", "model", "text", undefined, "ta");
    const legacy = buildBrandVoiceTtsOperationKey("voice", "model", "text");
    expect(te).not.toBe(ta);
    expect(te).toContain("brand-voice-tts-v2:");
    expect(legacy).toContain("brand-voice-tts-v1:");
  });
});