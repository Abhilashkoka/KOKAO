/**
 * The overlay planner is tested as pure arithmetic; the compositor is tested
 * by encoding real video and reading pixels back.
 *
 * That split is deliberate. Chained `xfade` offsets are the kind of thing that
 * looks right and renders wrong, so the maths gets exhaustive unit coverage.
 * Everything downstream of it — alpha merging, the feather, whether a gap
 * actually shows the plate — can only be proven by looking at the output.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import sharp from "sharp";

import {
  BrollPlanError,
  DEFAULT_CROSSFADE_MS,
  compositeBroll,
  planBeatTrack,
  renderFeatherMask,
  type BrollBeat,
} from "./brollOverlay";

const execFileAsync = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = await hasFfmpeg();

/* ------------------------------------------------------------------ *
 * planBeatTrack
 * ------------------------------------------------------------------ */

const beat = (startMs: number, endMs: number, extra: Partial<BrollBeat> = {}): BrollBeat => ({
  file: "/tmp/x.mp4",
  startMs,
  endMs,
  ...extra,
});

describe("planBeatTrack", () => {
  it("returns a single segment and no joins for one beat", () => {
    const plan = planBeatTrack([beat(0, 5000)]);
    expect(plan.segments).toHaveLength(1);
    expect(plan.offsetsSec).toEqual([]);
    expect(plan.crossfadeMs).toBe(0);
    expect(plan.trackDurationMs).toBe(5000);
  });

  it("chains back-to-back beats without shortening their absolute timeline", () => {
    const plan = planBeatTrack([beat(0, 5000), beat(5000, 10000), beat(10000, 15000)], {
      crossfadeMs: 700,
    });
    expect(plan.segments.map((s) => s.kind)).toEqual(["beat", "beat", "beat"]);
    expect(plan.trackDurationMs).toBe(15000);
    expect(plan.offsetsSec).toEqual([4.3, 9.3]);
  });

  it("fills a hole between beats with a transparent gap", () => {
    const plan = planBeatTrack([beat(0, 4000), beat(9000, 13000)], { crossfadeMs: 500 });
    expect(plan.segments.map((s) => s.kind)).toEqual(["beat", "gap", "beat"]);
    expect(plan.segments[1]).toMatchObject({ startMs: 4000, endMs: 9000 });
  });

  it("fills a leading hole when the first beat starts late", () => {
    const plan = planBeatTrack([beat(3000, 8000)], { crossfadeMs: 500 });
    expect(plan.segments.map((s) => s.kind)).toEqual(["gap", "beat"]);
    expect(plan.segments[0]).toMatchObject({ startMs: 0, endMs: 3000 });
  });

  it("keeps the beat index so the caller can find its source file", () => {
    const beats = [beat(0, 4000), beat(9000, 13000)];
    const plan = planBeatTrack(beats, { crossfadeMs: 500 });
    expect(plan.segments.filter((s) => s.kind === "beat").map((s) => s.beatIndex)).toEqual([0, 1]);
  });

  it("sorts beats given out of order", () => {
    const plan = planBeatTrack([beat(5000, 9000), beat(0, 5000)], { crossfadeMs: 400 });
    expect(plan.segments.map((s) => s.startMs)).toEqual([0, 5000]);
  });

  it("clamps a crossfade longer than the shortest segment can carry", () => {
    const plan = planBeatTrack([beat(0, 1000), beat(1000, 9000)], { crossfadeMs: 5000 });
    // 40% of the 1s segment, not the 5s asked for — a longer fade than the
    // clip it joins produces a broken chain.
    expect(plan.crossfadeMs).toBe(400);
  });

  it("defaults the crossfade when none is given", () => {
    const plan = planBeatTrack([beat(0, 8000), beat(8000, 16000)]);
    expect(plan.crossfadeMs).toBe(DEFAULT_CROSSFADE_MS);
  });

  it("rejects an empty beat list", () => {
    expect(() => planBeatTrack([])).toThrow(BrollPlanError);
  });

  it("rejects a beat that ends before it starts", () => {
    expect(() => planBeatTrack([beat(5000, 5000)])).toThrow(/ends before/);
  });

  it("rejects overlapping beats", () => {
    expect(() => planBeatTrack([beat(0, 6000), beat(4000, 9000)])).toThrow(/overlaps/);
  });

  it("rejects an opacity outside 0–1", () => {
    expect(() => planBeatTrack([beat(0, 5000, { opacity: 1.4 })])).toThrow(/opacity/);
  });

  it("accepts a trailing hole implicitly by ending the track early", () => {
    // No trailing gap segment: the compositor leaves the plate alone once the
    // overlay track runs out, so a hole at the end costs nothing.
    const plan = planBeatTrack([beat(0, 5000)]);
    expect(plan.segments.at(-1)!.kind).toBe("beat");
  });
});

/* ------------------------------------------------------------------ *
 * renderFeatherMask
 * ------------------------------------------------------------------ */

async function column(mask: Buffer, width: number): Promise<number[]> {
  const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
  const out: number[] = [];
  for (let y = 0; y < info.height; y += 1) {
    out.push(data[y * info.width * info.channels]!);
  }
  void width;
  return out;
}

describe("renderFeatherMask", () => {
  it("is opaque above the feather and transparent at the very bottom", async () => {
    const values = await column(await renderFeatherMask(64, 100, 0.2, 1), 64);
    expect(values[0]).toBe(255);
    expect(values[50]).toBe(255);
    expect(values[99]).toBeLessThan(20);
  });

  it("descends monotonically through the feather", async () => {
    const values = await column(await renderFeatherMask(64, 100, 0.4, 1), 64);
    for (let y = 61; y < 100; y += 1) {
      expect(values[y]!).toBeLessThanOrEqual(values[y - 1]!);
    }
  });

  it("scales the whole ramp by the beat's opacity", async () => {
    const values = await column(await renderFeatherMask(64, 100, 0.2, 0.5), 64);
    expect(values[0]).toBeGreaterThan(120);
    expect(values[0]).toBeLessThan(135);
  });

  it("is fully transparent at zero opacity", async () => {
    const values = await column(await renderFeatherMask(32, 40, 0.2, 0), 32);
    expect(Math.max(...values)).toBe(0);
  });

  it("survives a nonsense feather fraction without throwing", async () => {
    await expect(renderFeatherMask(32, 40, 5, 1)).resolves.toBeInstanceOf(Buffer);
    await expect(renderFeatherMask(32, 40, -1, 1)).resolves.toBeInstanceOf(Buffer);
  });
});

/* ------------------------------------------------------------------ *
 * compositeBroll — real encodes
 * ------------------------------------------------------------------ */

async function makeClip(
  dir: string,
  name: string,
  colour: string,
  seconds: number,
  size = "540x540",
): Promise<string> {
  const path = join(dir, name);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=${size}:d=${seconds}:r=30`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { timeout: 120_000 },
  );
  return path;
}

async function makePlate(dir: string, seconds: number): Promise<Buffer> {
  const path = join(dir, "plate.mp4");
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=360x640:d=${seconds}:r=30`,
      "-f",
      "lavfi",
      "-i",
      `sine=f=300:d=${seconds}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    { timeout: 120_000 },
  );
  return readFile(path);
}

/** Mean RGB of a band of the frame at time `t`. */
async function bandMean(
  video: Buffer,
  atSec: number,
  crop: string,
): Promise<{ r: number; g: number; b: number }> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-broll-probe-"));
  try {
    const src = join(dir, "in.mp4");
    await (await import("node:fs/promises")).writeFile(src, video);
    const png = join(dir, "f.png");
    await execFileAsync(
      "ffmpeg",
      ["-y", "-ss", String(atSec), "-i", src, "-vf", `crop=${crop}`, "-frames:v", "1", png],
      { timeout: 60_000 },
    );
    const stats = await sharp(png).stats();
    return {
      r: stats.channels[0]!.mean,
      g: stats.channels[1]!.mean,
      b: stats.channels[2]!.mean,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!FFMPEG)("compositeBroll", () => {
  it(
    "shows a beat over the plate and leaves a gap showing the plate",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kokao-broll-fixture-"));
      try {
        const plate = await makePlate(dir, 12);
        const red = await makeClip(dir, "red.mp4", "red", 6);
        const watermark = await sharp({
          create: {
            width: 80,
            height: 30,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0.9 },
          },
        })
          .png()
          .toBuffer();

        // Beat for the first 4s, then a deliberate hole — the shape this format
        // uses to let the presenter land a closing line unassisted.
        const out = await compositeBroll({
          baseVideo: plate,
          beats: [{ file: red, startMs: 0, endMs: 4000 }],
          width: 360,
          height: 640,
          crossfadeMs: 400,
          durationMs: 12_000,
          captions: [
            { text: "Plan the week.", startMs: 0, endMs: 5_000 },
            { text: "Then protect the time.", startMs: 5_000, endMs: 12_000 },
          ],
          captionStyle: "dynamic",
          accentColor: "#6D28D9",
          watermark,
        });

        // Top band during the beat: the red overlay dominates.
        const during = await bandMean(out, 1.5, "360:200:0:0");
        expect(during.r).toBeGreaterThan(150);
        expect(during.g).toBeLessThan(60);

        // Same band after the track ends: back to the black plate.
        const after = await bandMean(out, 8, "360:200:0:0");
        expect(after.r).toBeLessThan(30);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    "feathers the bottom of the box so the beat fades into the plate",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kokao-broll-feather-"));
      try {
        const plate = await makePlate(dir, 8);
        const red = await makeClip(dir, "red.mp4", "red", 8);
        const out = await compositeBroll({
          baseVideo: plate,
          beats: [{ file: red, startMs: 0, endMs: 6000 }],
          width: 360,
          height: 640,
          geometry: { heightFraction: 0.5, featherFraction: 0.3 },
        });

        // Box is 320px tall. Sample the top of it and the last few rows.
        const top = await bandMean(out, 2, "360:60:0:0");
        const bottomEdge = await bandMean(out, 2, "360:12:0:306");
        expect(top.r).toBeGreaterThan(180);
        expect(bottomEdge.r).toBeLessThan(top.r * 0.5);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    "honours per-beat opacity",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kokao-broll-opacity-"));
      try {
        const plate = await makePlate(dir, 14);
        const red = await makeClip(dir, "red.mp4", "red", 6);
        const out = await compositeBroll({
          baseVideo: plate,
          beats: [
            { file: red, startMs: 0, endMs: 5000, opacity: 1 },
            { file: red, startMs: 5000, endMs: 10000, opacity: 0.35 },
          ],
          width: 360,
          height: 640,
          crossfadeMs: 400,
        });

        const opaque = await bandMean(out, 1.5, "360:120:0:0");
        const faint = await bandMean(out, 7.5, "360:120:0:0");
        const nearPlannedEnd = await bandMean(out, 9.7, "360:120:0:0");
        const afterPlannedEnd = await bandMean(out, 10.5, "360:120:0:0");
        expect(opaque.r).toBeGreaterThan(faint.r * 1.8);
        expect(faint.r).toBeGreaterThan(20);
        expect(nearPlannedEnd.r).toBeGreaterThan(20);
        expect(afterPlannedEnd.r).toBeLessThan(20);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    "loops footage shorter than its slot instead of ending the chain early",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kokao-broll-loop-"));
      try {
        const plate = await makePlate(dir, 12);
        const short = await makeClip(dir, "short.mp4", "red", 2);
        const out = await compositeBroll({
          baseVideo: plate,
          beats: [{ file: short, startMs: 0, endMs: 9000 }],
          width: 360,
          height: 640,
        });
        // Late in a slot four times the clip's length, the overlay is still there.
        const late = await bandMean(out, 7.5, "360:120:0:0");
        expect(late.r).toBeGreaterThan(150);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    "keeps the plate's own audio and its full length",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kokao-broll-audio-"));
      try {
        const plate = await makePlate(dir, 10);
        const red = await makeClip(dir, "red.mp4", "red", 4);
        const out = await compositeBroll({
          baseVideo: plate,
          beats: [{ file: red, startMs: 0, endMs: 4000 }],
          width: 360,
          height: 640,
        });

        const probeDir = await mkdtemp(join(tmpdir(), "kokao-broll-p-"));
        const src = join(probeDir, "o.mp4");
        await (await import("node:fs/promises")).writeFile(src, out);
        const { stdout } = await execFileAsync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            src,
          ],
          { timeout: 60_000 },
        );
        await rm(probeDir, { recursive: true, force: true });
        expect(stdout).toContain("audio");
        const duration = Number(stdout.trim().split("\n").at(-1));
        expect(duration).toBeGreaterThan(9);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});