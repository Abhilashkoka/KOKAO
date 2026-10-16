/**
 * Tempo and first-beat detection for an uploaded music track, done in the
 * browser so a reel can be cut on the beat before anything is generated.
 *
 * Method: an onset-strength envelope (rise in short-window energy), then
 * autocorrelation over 70-180 BPM to find the beat period, then the phase that
 * lines up best with the onsets. Good enough for the steady pop/devotional/
 * instrumental tracks reels use; a track with no clear pulse returns null.
 */
export interface BeatInfo {
  bpm: number;
  /** Seconds per 4-beat bar. */
  barSec: number;
  /** Time of the first beat, where the music should start. */
  firstBeatSec: number;
}

const HOP = 512;
const MIN_BPM = 70;
const MAX_BPM = 180;

/** Onset envelope: positive change in RMS energy per hop. */
export function onsetEnvelope(samples: Float32Array, hop = HOP): Float32Array {
  const frames = Math.floor(samples.length / hop);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = samples[start + i]!;
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / hop);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  return onset;
}

/** Tempo and phase from an onset envelope sampled every `hopSec` seconds. */
export function detectBeat(onset: Float32Array, hopSec: number): BeatInfo | null {
  const n = onset.length;
  if (n < 64) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i]!;
  mean /= n;
  if (mean <= 0) return null;

  const minLag = Math.max(1, Math.floor(60 / MAX_BPM / hopSec));
  const maxLag = Math.min(n - 1, Math.ceil(60 / MIN_BPM / hopSec));
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < n; i++) score += (onset[i]! - mean) * (onset[i - lag]! - mean);
    score /= n - lag;
    // Mild preference for the common 90-140 BPM band over half/double tempo.
    const bpm = 60 / (lag * hopSec);
    const weight = bpm >= 90 && bpm <= 140 ? 1.15 : 1;
    if (score * weight > bestScore) {
      bestScore = score * weight;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return null;

  // Refine the period with parabolic interpolation around the best lag.
  const ac = (lag: number) => {
    let s = 0;
    for (let i = lag; i < n; i++) s += (onset[i]! - mean) * (onset[i - lag]! - mean);
    return s / (n - lag);
  };
  const y0 = ac(bestLag - 1);
  const y1 = ac(bestLag);
  const y2 = ac(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const periodFrames = bestLag + offset;
  const beatSec = periodFrames * hopSec;

  // Phase: the offset within one period whose beat grid collects most onset.
  const steps = Math.max(1, Math.round(periodFrames));
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let p = 0; p < steps; p++) {
    let s = 0;
    for (let t = p; t < n; t += periodFrames) s += onset[Math.round(t)] ?? 0;
    if (s > bestPhaseScore) {
      bestPhaseScore = s;
      bestPhase = p;
    }
  }
  const bpm = 60 / beatSec;
  return {
    bpm: Math.round(bpm * 10) / 10,
    barSec: Math.round(beatSec * 4 * 1000) / 1000,
    firstBeatSec: Math.round(bestPhase * hopSec * 1000) / 1000,
  };
}

/** Decode a music file in the browser and detect its beat (first 60s). */
export async function analyzeMusicFile(file: File): Promise<BeatInfo | null> {
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const length = Math.min(audio.length, audio.sampleRate * 60);
    const mono = new Float32Array(length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i]! += data[i]! / audio.numberOfChannels;
    }
    return detectBeat(onsetEnvelope(mono), HOP / audio.sampleRate);
  } catch {
    return null;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

/**
 * Seconds a look stays on screen for a given number of bars, and the integer
 * clip length to ask a video model for (it is trimmed back to the bars).
 */
export function lookTiming(
  beat: BeatInfo | null,
  bars: number,
  mode: "video" | "photo",
): { onScreenSec: number; clipSec: number } {
  if (!beat) return mode === "video" ? { onScreenSec: 5, clipSec: 5 } : { onScreenSec: 3, clipSec: 3 };
  const onScreenSec = Math.round(beat.barSec * bars * 1000) / 1000;
  return { onScreenSec, clipSec: Math.max(2, Math.ceil(onScreenSec)) };
}
