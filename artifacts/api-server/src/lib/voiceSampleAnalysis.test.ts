import { describe, it, expect } from "vitest";
import { analyzeVoicePcm, analyzeVoiceSampleBuffer } from "./voiceSampleAnalysis";

const RATE = 16_000;

/** Synthesize `seconds` of speech-like audio: bursts of a sine at `speechAmp`
 * separated by pauses whose floor is `noiseAmp` of white noise. */
function synth(opts: {
  seconds: number;
  speechAmp: number;
  noiseAmp?: number;
  clip?: boolean;
}): Float32Array {
  const { seconds, speechAmp, noiseAmp = 0.001, clip = false } = opts;
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // 1 s speech, 1.5 s pause, repeating — pauses long enough that some
    // analysis windows fall entirely inside them (like real speech pauses).
    const inSpeech = t % 2.5 < 1.0;
    const noise = (deterministicNoise(i) * 2 - 1) * noiseAmp;
    if (inSpeech) {
      let v = Math.sin(2 * Math.PI * 220 * t) * speechAmp + noise;
      if (clip) v = Math.max(-1, Math.min(1, v * 3));
      out[i] = v;
    } else {
      out[i] = noise;
    }
  }
  return out;
}

/** Cheap deterministic pseudo-noise in [0,1). */
function deterministicNoise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

describe("analyzeVoicePcm", () => {
  it("passes a clean 30s speech-like sample", () => {
    expect(analyzeVoicePcm(synth({ seconds: 30, speechAmp: 0.4 }), RATE)).toEqual([]);
  });

  it("flags a sample shorter than 20s", () => {
    expect(analyzeVoicePcm(synth({ seconds: 10, speechAmp: 0.4 }), RATE)).toContain(
      "too-short",
    );
  });

  it("flags a sample longer than 90s", () => {
    expect(analyzeVoicePcm(synth({ seconds: 95, speechAmp: 0.4 }), RATE)).toContain(
      "too-long",
    );
  });

  it("flags a nearly silent sample as too-quiet", () => {
    expect(analyzeVoicePcm(synth({ seconds: 30, speechAmp: 0.005 }), RATE)).toContain(
      "too-quiet",
    );
  });

  it("flags a heavily clipped sample", () => {
    expect(
      analyzeVoicePcm(synth({ seconds: 30, speechAmp: 0.9, clip: true }), RATE),
    ).toContain("clipped");
  });

  it("flags steady background noise", () => {
    expect(
      analyzeVoicePcm(synth({ seconds: 30, speechAmp: 0.3, noiseAmp: 0.15 }), RATE),
    ).toContain("noisy");
  });

  it("returns no issues for empty input", () => {
    expect(analyzeVoicePcm(new Float32Array(0), RATE)).toEqual([]);
  });
});

describe("analyzeVoiceSampleBuffer", () => {
  it("decodes a WAV via ffmpeg and analyzes it", async () => {
    const pcm = synth({ seconds: 25, speechAmp: 0.4 });
    const issues = await analyzeVoiceSampleBuffer(pcmToWav(pcm));
    expect(issues).toEqual([]);
  });

  it("returns null (fail-open) for undecodable bytes", async () => {
    const issues = await analyzeVoiceSampleBuffer(Buffer.from("not audio at all"));
    expect(issues).toBeNull();
  });
});

/** Wrap Float32 PCM in a minimal 16-bit mono WAV container. */
function pcmToWav(data: Float32Array): Buffer {
  const bytesPerSample = 2;
  const dataSize = data.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]!));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}
