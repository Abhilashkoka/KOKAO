export const VOICE_SAMPLE_RATE = 16_000;

/** Synthesize speech-like audio with speech bursts separated by noisy pauses. */
export function synthVoiceSample(opts: {
  seconds: number;
  speechAmp: number;
  noiseAmp?: number;
  clip?: boolean;
}): Float32Array {
  const { seconds, speechAmp, noiseAmp = 0.001, clip = false } = opts;
  const n = Math.floor(seconds * VOICE_SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / VOICE_SAMPLE_RATE;
    const inSpeech = t % 2.5 < 1.0;
    const noise = (deterministicNoise(i) * 2 - 1) * noiseAmp;
    if (inSpeech) {
      let value = Math.sin(2 * Math.PI * 220 * t) * speechAmp + noise;
      if (clip) value = Math.max(-1, Math.min(1, value * 3));
      out[i] = value;
    } else {
      out[i] = noise;
    }
  }
  return out;
}

/** Wrap Float32 PCM in a minimal 16-bit mono WAV container. */
export function pcmToWav(data: Float32Array): Buffer {
  const bytesPerSample = 2;
  const dataSize = data.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
  buf.writeUInt32LE(VOICE_SAMPLE_RATE * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < data.length; i++) {
    const value = Math.max(-1, Math.min(1, data[i]!));
    buf.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buf;
}

/** Cheap deterministic pseudo-noise in [0,1). */
function deterministicNoise(i: number): number {
  const value = Math.sin(i * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}