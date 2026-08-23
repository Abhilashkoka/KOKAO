import { describe, it, expect } from "vitest";
import { analyzeVoicePcm, analyzeVoiceSampleBuffer } from "./voiceSampleAnalysis";
import {
  pcmToWav,
  synthVoiceSample,
  VOICE_SAMPLE_RATE,
} from "../test/voiceSampleFixtures";

describe("analyzeVoicePcm", () => {
  it("passes a clean 30s speech-like sample", () => {
    expect(analyzeVoicePcm(synthVoiceSample({ seconds: 30, speechAmp: 0.4 }), VOICE_SAMPLE_RATE)).toEqual([]);
  });

  it("flags a sample shorter than 20s", () => {
    expect(analyzeVoicePcm(synthVoiceSample({ seconds: 10, speechAmp: 0.4 }), VOICE_SAMPLE_RATE)).toContain(
      "too-short",
    );
  });

  it("flags a sample longer than 90s", () => {
    expect(analyzeVoicePcm(synthVoiceSample({ seconds: 95, speechAmp: 0.4 }), VOICE_SAMPLE_RATE)).toContain(
      "too-long",
    );
  });

  it("flags a nearly silent sample as too-quiet", () => {
    expect(analyzeVoicePcm(synthVoiceSample({ seconds: 30, speechAmp: 0.005 }), VOICE_SAMPLE_RATE)).toContain(
      "too-quiet",
    );
  });

  it("flags a heavily clipped sample", () => {
    expect(
      analyzeVoicePcm(synthVoiceSample({ seconds: 30, speechAmp: 0.9, clip: true }), VOICE_SAMPLE_RATE),
    ).toContain("clipped");
  });

  it("flags steady background noise", () => {
    expect(
      analyzeVoicePcm(synthVoiceSample({ seconds: 30, speechAmp: 0.3, noiseAmp: 0.15 }), VOICE_SAMPLE_RATE),
    ).toContain("noisy");
  });

  it("returns no issues for empty input", () => {
    expect(analyzeVoicePcm(new Float32Array(0), VOICE_SAMPLE_RATE)).toEqual([]);
  });
});

describe("analyzeVoiceSampleBuffer", () => {
  it("decodes a WAV via ffmpeg and analyzes it", async () => {
    const pcm = synthVoiceSample({ seconds: 25, speechAmp: 0.4 });
    const issues = await analyzeVoiceSampleBuffer(pcmToWav(pcm));
    expect(issues).toEqual([]);
  });

  it("returns null (fail-open) for undecodable bytes", async () => {
    const issues = await analyzeVoiceSampleBuffer(Buffer.from("not audio at all"));
    expect(issues).toBeNull();
  });
});
