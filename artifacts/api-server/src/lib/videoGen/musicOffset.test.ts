import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  chooseOffsetFromTimeline,
  parseEbur128Timeline,
  pickMusicStartOffsetSec,
} from "./musicOffset";
import { diversifySceneClips, type SceneSegment } from "./topicVideo/compose";

describe("diversifySceneClips", () => {
  const scene = (clipIndex: number, durationSec = 2): SceneSegment => ({ clipIndex, durationSec });

  it("breaks up adjacent repeats of the same clip", () => {
    const out = diversifySceneClips([scene(0), scene(0), scene(1)], 3);
    expect(out[1]!.clipIndex).not.toBe(0);
    expect(out[1]!.clipIndex).not.toBe(1); // prefers differing from BOTH neighbors
    expect(out.map((s) => s.durationSec)).toEqual([2, 2, 2]);
  });

  it("leaves already-diverse layouts untouched", () => {
    const layout = [scene(0), scene(1), scene(0), scene(2)];
    expect(diversifySceneClips(layout, 3)).toEqual(layout);
  });

  it("is a no-op with a single clip", () => {
    const layout = [scene(0), scene(0), scene(0)];
    expect(diversifySceneClips(layout, 1)).toEqual(layout);
    expect(diversifySceneClips(layout, 1)).toBe(layout);
  });

  it("with two clips, alternates instead of repeating", () => {
    const out = diversifySceneClips([scene(0), scene(0), scene(0)], 2);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.clipIndex).not.toBe(out[i - 1]!.clipIndex);
    }
  });

  it("does not mutate its input", () => {
    const layout = [scene(0), scene(0)];
    diversifySceneClips(layout, 2);
    expect(layout[1]!.clipIndex).toBe(0);
  });
});

describe("chooseOffsetFromTimeline", () => {
  const quietThenLoud = [
    { t: 0.1, m: -60 },
    { t: 5.0, m: -55 },
    { t: 10.0, m: -18 },
    { t: 15.0, m: -16 },
  ];

  it("skips a quiet intro, keeping a lead-in", () => {
    // Active from t=10 (peak -16, threshold -28); lead-in 1s → 9.
    expect(chooseOffsetFromTimeline(quietThenLoud, 60, 20)).toBe(9);
  });

  it("returns 0 when the track starts strong", () => {
    const strong = [
      { t: 0.1, m: -17 },
      { t: 5.0, m: -16 },
    ];
    expect(chooseOffsetFromTimeline(strong, 60, 20)).toBe(0);
  });

  it("clamps so the video still fits inside the track", () => {
    // Would want 9, but only 60-55=5 of headroom.
    expect(chooseOffsetFromTimeline(quietThenLoud, 60, 55)).toBe(5);
  });

  it("returns 0 for empty or sub-threshold timelines", () => {
    expect(chooseOffsetFromTimeline([], 60, 20)).toBe(0);
  });
});

describe("parseEbur128Timeline", () => {
  it("parses ffmpeg's momentary-loudness log lines", () => {
    const stderr = [
      "[Parsed_ebur128_0 @ 0x55] t: 0.099979    TARGET:-23 LUFS    M: -120.7 S: -120.7     I: -70.0 LUFS       LRA:   0.0 LU",
      "[Parsed_ebur128_0 @ 0x55] t: 2.199979    TARGET:-23 LUFS    M: -17.3 S: -19.6     I: -20.3 LUFS       LRA:   1.2 LU",
    ].join("\n");
    expect(parseEbur128Timeline(stderr)).toEqual([
      { t: 0.099979, m: -120.7 },
      { t: 2.199979, m: -17.3 },
    ]);
  });
});

describe("pickMusicStartOffsetSec (real ffmpeg)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kokao-music-"));
    // 6s of near-silence, then 24s of tone: the "long quiet intro" shape.
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=6",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=24",
        "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
        "-map", "[a]",
        "quiet-intro.wav",
      ],
      { cwd: dir, timeout: 60_000 },
    );
    if (result.status !== 0) {
      throw new Error(`fixture encode failed: ${result.stderr?.toString().slice(-300)}`);
    }
    return async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
  });

  it("finds the start of the musical part", async () => {
    const offset = await pickMusicStartOffsetSec("quiet-intro.wav", dir, 10);
    expect(offset).toBeGreaterThan(3);
    expect(offset).toBeLessThan(7);
  });

  it("fails soft to 0 for a missing file", async () => {
    expect(await pickMusicStartOffsetSec("nope.wav", dir, 10)).toBe(0);
  });
});
