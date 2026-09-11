import { describe, expect, it } from "vitest";
import {
  conservativeSpeechDurationSeconds,
  wavDurationSeconds,
} from "./audioDuration";

function wavWithMetadata(durationSec: number): Buffer {
  const byteRate = 48_000;
  const pcm = Buffer.alloc(byteRate * durationSec);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(24_000, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const metadata = Buffer.from("JUNK\u0004\u0000\u0000\u0000test", "binary");
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([fmt, metadata, dataHeader, pcm]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WAVE", 8);
  return Buffer.concat([riff, body]);
}

describe("wavDurationSeconds", () => {
  it("uses the data and fmt chunks even when metadata changes their offsets", () => {
    expect(wavDurationSeconds(wavWithMetadata(2))).toBe(2);
  });

  it("returns null for non-WAV and malformed WAV data", () => {
    expect(wavDurationSeconds(Buffer.from("compressed"))).toBeNull();
    expect(wavDurationSeconds(Buffer.from("RIFF0000WAVE"))).toBeNull();
  });
});

describe("conservativeSpeechDurationSeconds", () => {
  it("reserves from both word and character pacing", () => {
    expect(conservativeSpeechDurationSeconds("one two three")).toBe(2);
    expect(conservativeSpeechDurationSeconds("abcdefghijklmnop")).toBe(2);
  });
});