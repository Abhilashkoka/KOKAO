import { describe, it, expect } from "vitest";
import {
  parseWav,
  buildWav,
  sliceNarration,
  LIP_SYNC_NOISE_FLOOR_DBFS,
} from "./narration";

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
    // Seconds 2..3 of the ramp carry the value 3000 throughout. Compared with a
    // tolerance rather than exactly: the lip-sync noise floor rides under every
    // slice, and its whole point is that nothing is bit-identical any more.
    const { pcm } = parseWav(sliceNarration(rampTrack(5), 2, 3));
    const ceiling = Math.round(32767 * Math.pow(10, LIP_SYNC_NOISE_FLOOR_DBFS / 20));
    expect(Math.abs(pcm.readInt16LE(0) - 3000)).toBeLessThanOrEqual(ceiling);
    expect(
      Math.abs(pcm.readInt16LE(pcm.length - BLOCK_ALIGN) - 3000),
    ).toBeLessThanOrEqual(ceiling);
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

describe("lip-sync noise floor", () => {
  it("leaves no digital silence in a slice", () => {
    // A gap between sentences is Buffer.alloc — every sample zero. That input
    // made the model hold the mouth half-open instead of closing it.
    const silent = buildWav(FORMAT, Buffer.alloc(BYTE_RATE * 2));
    const { pcm } = parseWav(sliceNarration(silent, 0, 2));
    let nonZero = 0;
    for (let i = 0; i + 2 <= pcm.length; i += 2) if (pcm.readInt16LE(i) !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(pcm.length / 2 / 4);
  });

  it("keeps the floor far below anything audible", () => {
    const silent = buildWav(FORMAT, Buffer.alloc(BYTE_RATE * 2));
    const { pcm } = parseWav(sliceNarration(silent, 0, 2));
    const ceiling = Math.round(32767 * Math.pow(10, LIP_SYNC_NOISE_FLOOR_DBFS / 20));
    let peak = 0;
    for (let i = 0; i + 2 <= pcm.length; i += 2) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(ceiling);
    // ~60dB down: four orders of magnitude under full scale.
    expect(peak).toBeLessThan(64);
  });

  it("does not disturb the speech it sits under", () => {
    // The ramp carries 3000 through second 2; the floor may nudge it by at
    // most its peak, which is far below any speech feature the model reads.
    const { pcm } = parseWav(sliceNarration(rampTrack(5), 2, 3));
    const ceiling = Math.round(32767 * Math.pow(10, LIP_SYNC_NOISE_FLOOR_DBFS / 20));
    for (let i = 0; i + 2 <= pcm.length; i += 2) {
      expect(Math.abs(pcm.readInt16LE(i) - 3000)).toBeLessThanOrEqual(ceiling);
    }
  });

  it("is deterministic, so a retry renders the same bytes", () => {
    const track = rampTrack(4);
    expect(sliceNarration(track, 1, 3).equals(sliceNarration(track, 1, 3))).toBe(true);
  });

  it("never modifies the caller's narration track", () => {
    // sliceNarration used to hand back a view into this buffer; writing the
    // floor into a view would corrupt the track the video is composed from.
    const track = rampTrack(4);
    const before = Buffer.from(track);
    sliceNarration(track, 1, 3);
    expect(track.equals(before)).toBe(true);
  });

  it("leaves a non-16-bit slice untouched rather than corrupting it", () => {
    const eightBit = { ...FORMAT, bitsPerSample: 8, blockAlign: 1, byteRate: SAMPLE_RATE };
    const pcm = Buffer.alloc(SAMPLE_RATE);
    const out = parseWav(sliceNarration(buildWav(eightBit, pcm), 0, 1)).pcm;
    expect(out.every((byte) => byte === 0)).toBe(true);
  });
});
