import { describe, expect, it } from "vitest";
import { assessNativeAudioTranscript, detectTranscriptLocale } from "./nativeAudioGate";

describe("native Guided audio assessment", () => {
  it("accepts the requested language and dialogue", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: "The market opens at sunrise.",
    })).toEqual({ outcome: "pass", detectedLocale: "en" });
  });

  it("reports a major language mismatch separately", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: "El mercado abre al amanecer.",
      providerDetectedLanguage: "es",
    })).toEqual({ outcome: "wrong_language", detectedLocale: "es" });
  });

  it("does not invent a language from uncertain detection", () => {
    expect(detectTranscriptLocale("OK 2")).toBeNull();
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "OK 2",
      transcript: "OK 2",
    })).toEqual({ outcome: "pass", detectedLocale: null });
  });

  it("reports exact-dialogue drift separately from language drift", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: "A completely different English sentence was spoken.",
    })).toEqual({ outcome: "dialogue_drift", detectedLocale: "en" });
  });

  it("rejects materially reordered dialogue", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The dog follows the man before sunrise",
      transcript: "Before sunrise the man follows the dog",
      providerDetectedLanguage: "english",
    })).toEqual({ outcome: "dialogue_drift", detectedLocale: "en" });
  });

  it("treats a short conflicting language label as uncertain", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "No",
      transcript: "No",
      providerDetectedLanguage: "spanish",
    })).toEqual({ outcome: "pass", detectedLocale: null });
  });

  it("rejects clips with no transcribed speech", () => {
    expect(assessNativeAudioTranscript({
      expectedLocale: "en",
      expectedDialogue: "The market opens at sunrise",
      transcript: " ... ",
    })).toEqual({ outcome: "no_speech", detectedLocale: null });
  });
});