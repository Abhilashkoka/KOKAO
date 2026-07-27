import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { verifyRenderedVideo } from "./qaGate";

/**
 * Real-ffmpeg tests: each fixture is a tiny encoded MP4 shaped to trip (or
 * pass) exactly one gate check.
 */

let fixturesDir: string;

function encode(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-y", ...args], {
    cwd: fixturesDir,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`fixture encode failed: ${result.stderr?.toString().slice(-300)}`);
  }
}

async function fixture(name: string): Promise<Buffer> {
  return readFile(join(fixturesDir, name));
}

beforeAll(async () => {
  fixturesDir = await mkdtemp(join(tmpdir(), "kokao-qa-fixtures-"));

  // Bright test pattern + audible tone, 2s.
  encode([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "good.mp4",
  ]);
  // Pure black frames + audible tone, 2s.
  encode([
    "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=15:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "black.mp4",
  ]);
  // Bright picture + digital-silence audio track, 2s.
  encode([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=2",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "silent.mp4",
  ]);
  // Bright picture, NO audio stream, 2s.
  encode([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-an", "noaudio.mp4",
  ]);

  return async () => {
    await rm(fixturesDir, { recursive: true, force: true }).catch(() => {});
  };
});

describe("verifyRenderedVideo", () => {
  it("passes a healthy video with audio", async () => {
    await expect(
      verifyRenderedVideo(await fixture("good.mp4"), {
        expectedDurationSec: 2,
        expectAudio: true,
      }),
    ).resolves.toEqual({ durationSec: expect.any(Number) });
  });

  it("rejects an unplayable buffer", async () => {
    await expect(
      verifyRenderedVideo(Buffer.from("this is not a video file at all")),
    ).rejects.toThrow(/unplayable/);
  });

  it("rejects a render far shorter than intended", async () => {
    await expect(
      verifyRenderedVideo(await fixture("good.mp4"), { expectedDurationSec: 30 }),
    ).rejects.toThrow(/instead of/);
  });

  it("rejects a clip under the sanity floor", async () => {
    await expect(
      verifyRenderedVideo(await fixture("good.mp4"), { minDurationSec: 4 }),
    ).rejects.toThrow(/only .* long/);
  });

  it("rejects an all-black picture", async () => {
    await expect(verifyRenderedVideo(await fixture("black.mp4"))).rejects.toThrow(
      /black throughout/,
    );
  });

  it("rejects a silent narration track when audio is expected", async () => {
    await expect(
      verifyRenderedVideo(await fixture("silent.mp4"), { expectAudio: true }),
    ).rejects.toThrow(/silent/);
  });

  it("rejects a missing audio stream when audio is expected", async () => {
    await expect(
      verifyRenderedVideo(await fixture("noaudio.mp4"), { expectAudio: true }),
    ).rejects.toThrow(/silent/);
  });

  it("ignores audio entirely when none is expected", async () => {
    await expect(
      verifyRenderedVideo(await fixture("noaudio.mp4"), { expectedDurationSec: 2 }),
    ).resolves.toEqual({ durationSec: expect.any(Number) });
  });
});
