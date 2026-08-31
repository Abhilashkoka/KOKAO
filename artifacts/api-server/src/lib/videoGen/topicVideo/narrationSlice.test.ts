import { describe, it, expect } from "vitest";
import { parseWav, buildWav, sliceNarration } from "./narration";

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS = 16;
const BLOCK_ALIGN = (CHANNELS * BITS) / 8;
const BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN;

const FORMAT = {
  channels: CHANNELS,
  sampleRate: SAMPLE_RATE,
  bitsPerSample: BITS,
  byteRate: BYTE_RATE,
  blockAlign: BLOCK_ALIGN,
};

/**
 * A track whose sample VALUE encodes its own second, so a slice can be checked
 * for having come from the right place rather than merely the right length.
 */
function rampTrack(seconds: number): Buffer {
  const pcm = Buffer.alloc(BYTE_RATE * seconds);
  for (let i = 0; i < pcm.length / BLOCK_ALIGN; i++) {
    const second = Math.floor(i / SAMPLE_RATE);
    pcm.writeInt16LE((second + 1) * 1000, i * BLOCK_ALIGN);
  }
  return buildWav(FORMAT, pcm);
}

describe("sliceNarration", () => {
  it("cuts the requested span to the sample", () => {
    const slice = sliceNarration(rampTrack(5), 1, 3);
    const { durationSec, format } = parseWav(slice);
    expect(Math.abs(durationSec - 2)).toBeLessThan(0.001);
    expect(format.sampleRate).toBe(SAMPLE_RATE);
    expect(format.channels).toBe(CHANNELS);
  });

  it("takes the audio from the right place in the track", () => {
    // Seconds 2..3 of the ramp carry the value 3000 throughout.
    const { pcm } = parseWav(sliceNarration(rampTrack(5), 2, 3));
    expect(pcm.readInt16LE(0)).toBe(3000);
    expect(pcm.readInt16LE(pcm.length - BLOCK_ALIGN)).toBe(3000);
  });

  it("slices sum back to the whole track", () => {
    const track = rampTrack(6);
    const spans: Array<[number, number]> = [
      [0, 1.5],
      [1.5, 4],
      [4, 6],
    ];
    const total = spans.reduce(
      (sum, [from, to]) => sum + parseWav(sliceNarration(track, from, to)).durationSec,
      0,
    );
    expect(Math.abs(total - 6)).toBeLessThan(0.01);
  });

  it("clamps a span that runs past the end of the track", () => {
    const { durationSec } = parseWav(sliceNarration(rampTrack(3), 2, 99));
    expect(Math.abs(durationSec - 1)).toBeLessThan(0.01);
  });

  it("returns a valid empty WAV for an inverted or empty span", () => {
    for (const [from, to] of [
      [2, 2],
      [3, 1],
    ] as Array<[number, number]>) {
      const slice = sliceNarration(rampTrack(4), from, to);
      // Still parseable — a malformed file would break the model, not the job.
      expect(parseWav(slice).durationSec).toBe(0);
    }
  });
});
