import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { diversifySceneClips, composeTopicVideo, type SceneSegment } from "./topicVideo/compose";
import { buildWav } from "./topicVideo/narration";
import { runFfmpeg } from "./slideshow";
import { resplitLongHolds } from "./planGate";

/**
 * A quiet narration track of the requested length. Deliberately not digital
 * silence: the compositor runs loudnorm over the voice, and an all-zero track
 * is not a case this test is about.
 */
function toneWav(seconds: number): Buffer {
  const format = {
    channels: 1,
    sampleRate: 24_000,
    bitsPerSample: 16,
    byteRate: 48_000,
    blockAlign: 2,
  };
  const frames = Math.round(format.sampleRate * seconds);
  const pcm = Buffer.alloc(frames * format.blockAlign);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / format.sampleRate)), i * 2);
  }
  return buildWav(format, pcm);
}

/**
 * The four ways the timeline could silently desync a lip-synced shot. None of
 * them throws, none is visible in a log, and each produces a file that plays
 * perfectly while the mouth says something else — so each is pinned here.
 */

describe("diversifySceneClips leaves lip-synced shots alone", () => {
  it("never reassigns a locked scene's clip", () => {
    const scenes: SceneSegment[] = [
      { clipIndex: 0, durationSec: 2, lipSynced: true },
      { clipIndex: 0, durationSec: 2, lipSynced: true },
      { clipIndex: 0, durationSec: 2, lipSynced: true },
    ];
    expect(diversifySceneClips(scenes, 4).map((s) => s.clipIndex)).toEqual([0, 0, 0]);
  });

  it("never hands a locked clip to some other scene", () => {
    // Clip 1 carries a performance; the repeated b-roll scenes must find
    // something else to cut to, even though clip 1 is the least used.
    const scenes: SceneSegment[] = [
      { clipIndex: 1, durationSec: 2, lipSynced: true },
      { clipIndex: 0, durationSec: 2 },
      { clipIndex: 0, durationSec: 2 },
    ];
    const out = diversifySceneClips(scenes, 3);
    expect(out[0]!.clipIndex).toBe(1);
    expect(out[2]!.clipIndex).not.toBe(1);
    expect(out[2]!.clipIndex).not.toBe(0);
  });

  it("still diversifies an ordinary plan", () => {
    const scenes: SceneSegment[] = [
      { clipIndex: 0, durationSec: 2 },
      { clipIndex: 0, durationSec: 2 },
    ];
    const out = diversifySceneClips(scenes, 3);
    expect(out[1]!.clipIndex).not.toBe(0);
  });
});

describe("resplitLongHolds leaves lip-synced shots alone", () => {
  it("does not cut a long synced take in half", () => {
    const scenes: SceneSegment[] = [{ clipIndex: 0, durationSec: 12, lipSynced: true }];
    const out = resplitLongHolds(scenes, 3, 4);
    expect(out).toHaveLength(1);
    expect(out[0]!.durationSec).toBe(12);
  });

  it("still splits an ordinary long hold", () => {
    const scenes: SceneSegment[] = [{ clipIndex: 0, durationSec: 12 }];
    expect(resplitLongHolds(scenes, 3, 4).length).toBeGreaterThan(1);
  });

  it("never rotates a split onto footage carrying a performance", () => {
    const scenes: SceneSegment[] = [
      { clipIndex: 1, durationSec: 3, lipSynced: true },
      { clipIndex: 0, durationSec: 12 },
    ];
    const out = resplitLongHolds(scenes, 3, 4);
    const split = out.filter((s) => !s.lipSynced);
    expect(split.length).toBeGreaterThan(1);
    for (const piece of split) expect(piece.clipIndex).not.toBe(1);
  });

  it("preserves total scene time when a mixed plan is split", () => {
    const scenes: SceneSegment[] = [
      { clipIndex: 1, durationSec: 3, lipSynced: true },
      { clipIndex: 0, durationSec: 12 },
    ];
    const before = scenes.reduce((sum, s) => sum + s.durationSec, 0);
    const after = resplitLongHolds(scenes, 3, 4).reduce((sum, s) => sum + s.durationSec, 0);
    expect(Math.abs(after - before)).toBeLessThan(0.01);
  });
});

/**
 * The seek guard, proven end to end rather than by inspection.
 *
 * A three-colour clip stands in for a performance: if the compositor seeks
 * into it, the shot opens on the wrong colour, exactly as a real synced shot
 * would open on the wrong word. Scene index 1 is used deliberately — the
 * golden-ratio offset is zero for the first scene, so scene 0 would pass this
 * test even with the bug present.
 */
describe("composeTopicVideo does not seek into a lip-synced shot", () => {
  it("opens the shot at the start of its clip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-seekguard-"));
    try {
      // 6s: red, then green, then blue, two seconds each.
      await runFfmpeg(
        [
          "-y",
          "-f", "lavfi", "-i", "color=c=red:s=360x640:r=30:d=2",
          "-f", "lavfi", "-i", "color=c=green:s=360x640:r=30:d=2",
          "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30:d=2",
          "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]",
          "-map", "[v]",
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "clip.mp4",
        ],
        dir,
      );
      const clip = await readFile(join(dir, "clip.mp4"));

      const out = await composeTopicVideo({
        clips: [clip],
        narrationWav: toneWav(2),
        cues: [
          { text: "One.", startSec: 0, endSec: 1 },
          { text: "Two.", startSec: 1, endSec: 2 },
        ],
        totalDurationSec: 2,
        aspectRatio: "9:16",
        subtitles: false,
        music: null,
        sceneMap: [
          { clipIndex: 0, durationSec: 1 },
          { clipIndex: 0, durationSec: 1, lipSynced: true },
        ],
      });

      // Mid-way through the second shot. Unguarded, the golden-ratio offset
      // for scene 1 lands ~2.9s into the clip, which is green.
      await writeFile(join(dir, "out.mp4"), out);
      await runFfmpeg(
        [
          "-y", "-ss", "1.5", "-i", "out.mp4",
          "-frames:v", "1", "-vf", "scale=1:1",
          "-f", "rawvideo", "-pix_fmt", "rgb24", "px.raw",
        ],
        dir,
      );
      const [r, g, b] = await readFile(join(dir, "px.raw"));
      expect(r!).toBeGreaterThan(120);
      expect(g!).toBeLessThan(90);
      expect(b!).toBeLessThan(90);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);
});
