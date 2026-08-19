import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVoiceSampleFromVideo } from "./baseVideoAudio";
import { runFfmpeg } from "./videoGen/slideshow";

describe("extractVoiceSampleFromVideo (real ffmpeg)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "brand-video-audio-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("turns a video-container audio track into a compact mono MP3", async () => {
    const source = join(dir, "source.mp4");
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "1",
        "-c:a",
        "aac",
        source,
      ],
      dir,
      30_000,
    );

    const mp3 = await extractVoiceSampleFromVideo(await readFile(source));

    expect(mp3.length).toBeGreaterThan(1_000);
    expect(
      mp3.subarray(0, 3).toString("ascii") === "ID3" || mp3[0] === 0xff,
    ).toBe(true);
  });
});