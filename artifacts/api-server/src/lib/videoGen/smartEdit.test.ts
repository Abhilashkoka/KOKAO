import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SMART_EDIT_KEEP_VERSIONS,
  SmartEditInputError,
  cutSmartEditSegment,
  initialSmartEditState,
  nextSmartEditVersionId,
  probeVideoBuffer,
  smartEditAttemptStatus,
  smartEditClipPrompt,
  smartEditCurrentPath,
  smartEditFrameEdits,
  smartEditFramePrompt,
  smartEditMask,
  smartEditStitchArgs,
  stitchSmartEdit,
  validateSmartEditRequest,
  withSmartEditVersion,
} from "./smartEdit";

describe("validateSmartEditRequest", () => {
  it("normalizes a range, box and instruction", () => {
    const request = validateSmartEditRequest(
      { type: "change", startSec: 2, endSec: 5.5, box: { x: -0.1, y: 0.2, width: 0.5, height: 0.9 }, instruction: "  make the  bottle blue " },
      20,
    );
    expect(request).toMatchObject({ type: "change", startSec: 2, endSec: 5.5, instruction: "make the bottle blue" });
    expect(request.box).toEqual({ x: 0, y: 0.2, width: 0.5, height: 0.8 });
  });

  it("rejects bad ranges, missing boxes and empty instructions", () => {
    expect(() => validateSmartEditRequest({ type: "change", startSec: 4, endSec: 3, instruction: "x y z" }, 20)).toThrow(SmartEditInputError);
    expect(() => validateSmartEditRequest({ type: "change", startSec: 0, endSec: 15, instruction: "blue" }, 20)).toThrow(/at most 12/);
    expect(() => validateSmartEditRequest({ type: "change", startSec: 18, endSec: 25, instruction: "blue" }, 20)).toThrow(/past the end/);
    expect(() => validateSmartEditRequest({ type: "remove", startSec: 0, endSec: 3 }, 20)).toThrow(/box/);
    expect(() => validateSmartEditRequest({ type: "outfit", startSec: 0, endSec: 3, instruction: "" }, 20)).toThrow(/Describe/);
    expect(() => validateSmartEditRequest({ type: "dialogue", startSec: 0, endSec: 3 }, 20)).toThrow(/new line/);
    expect(validateSmartEditRequest({ type: "regenerate", startSec: 0, endSec: 3 }, 20).instruction).toBe("");
  });
});

describe("prompts and costs", () => {
  it("counts frame edits only for picture changes", () => {
    expect(smartEditFrameEdits({ type: "change", box: null }, true)).toBe(2);
    expect(smartEditFrameEdits({ type: "remove", box: { x: 0, y: 0, width: 1, height: 1 } }, false)).toBe(1);
    expect(smartEditFrameEdits({ type: "regenerate", box: null }, true)).toBe(0);
    expect(smartEditFrameEdits({ type: "dialogue", box: null }, true)).toBe(0);
  });

  it("keeps identity in outfit edits and quotes owner text as data", () => {
    expect(smartEditFramePrompt({ type: "outfit", instruction: "a red saree" })).toContain("Keep the person's face");
    const prompt = smartEditClipPrompt({ request: { type: "change", instruction: "bottle is blue" }, sceneVisual: "A shop counter.", hasEndFrame: true });
    expect(prompt).toContain('"bottle is blue"');
    expect(prompt).toContain("end exactly on the last frame");
  });
});

describe("masks", () => {
  it("makes only the box transparent", async () => {
    const mask = await smartEditMask(100, 200, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(10, 10)).toBe(255);
    expect(alphaAt(80, 180)).toBe(0);
    const whole = await sharp(await smartEditMask(10, 10, null)).raw().toBuffer();
    expect(whole[3]).toBe(0);
  });
});

describe("versions", () => {
  const job = { videoPath: "/objects/1/uploads/original", thumbnailPath: null, options: null };

  it("starts at the original and keeps the newest versions", () => {
    let state = initialSmartEditState(job, 20);
    expect(smartEditCurrentPath({ videoPath: job.videoPath, options: { aspectRatio: "9:16", smartEdit: state } })).toBeNull();
    for (let index = 0; index < SMART_EDIT_KEEP_VERSIONS + 3; index += 1) {
      state = withSmartEditVersion(state, {
        id: nextSmartEditVersionId(state), path: `/objects/1/uploads/v${index}`, thumbnailPath: null,
        durationSec: 20, createdAt: "", editId: `e${index}`, label: "Edit",
      });
    }
    expect(state.versions).toHaveLength(SMART_EDIT_KEEP_VERSIONS);
    expect(state.currentVersionId).toBe(`v${SMART_EDIT_KEEP_VERSIONS + 3}`);
    expect(smartEditCurrentPath({ videoPath: job.videoPath, options: { aspectRatio: "9:16", smartEdit: state } }))
      .toBe(`/objects/1/uploads/v${SMART_EDIT_KEEP_VERSIONS + 2}`);
  });

  it("derives live attempt status from the child job", () => {
    const attempt = { status: "generating", error: null } as never;
    expect(smartEditAttemptStatus(attempt, null)).toBe("generating");
    expect(smartEditAttemptStatus(attempt, { status: "processing", videoPath: null, error: null })).toBe("generating");
    expect(smartEditAttemptStatus(attempt, { status: "succeeded", videoPath: "/x", error: null })).toBe("ready");
    expect(smartEditAttemptStatus(attempt, { status: "failed", videoPath: null, error: "x" })).toBe("failed");
  });

  it("builds a 3-part concat and keeps original audio by default", () => {
    const args = smartEditStitchArgs({
      base: { durationSec: 10, width: 360, height: 640, fps: 30, hasAudio: true },
      clipHasAudio: false, startSec: 2, endSec: 5, clipSec: 3, audio: "original", output: "o.mp4",
    }).join(" ");
    expect(args).toContain("concat=n=3:v=1:a=0");
    expect(args).toContain("-map 0:a");
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("cut and stitch (ffmpeg)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "smart-edit-test-"));
    const run = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
    run(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=10", "-f", "lavfi", "-i", "sine=frequency=300:duration=10",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "base.mp4")]);
    // A regenerated clip at a different size, rate and length, without audio.
    run(["-f", "lavfi", "-i", "smptebars=size=720x1280:rate=24:duration=2.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "clip.mp4")]);
    run(["-f", "lavfi", "-i", "color=c=blue:size=360x640:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=900:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "line.mp4")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string) => readFileSync(join(dir, name));

  it("cuts a frame-accurate segment with its first and last frames", async () => {
    const cut = await cutSmartEditSegment(file("base.mp4"), 2, 5);
    const probe = await probeVideoBuffer(cut.clip);
    expect(probe.durationSec).toBeGreaterThan(2.9);
    expect(probe.durationSec).toBeLessThan(3.15);
    expect((await sharp(cut.startFrame).metadata()).width).toBe(360);
    expect((await sharp(cut.endFrame).metadata()).height).toBe(640);
  }, 60_000);

  it("stitches a picture edit back at the same length with the original sound", async () => {
    const result = await stitchSmartEdit({ base: file("base.mp4"), clip: file("clip.mp4"), startSec: 2, endSec: 5, audio: "original" });
    const probe = await probeVideoBuffer(result.video);
    expect(probe.durationSec).toBeGreaterThan(9.85);
    expect(probe.durationSec).toBeLessThan(10.2);
    expect(probe.width).toBe(360);
    expect(probe.hasAudio).toBe(true);
    expect(result.thumbnail.length).toBeGreaterThan(100);
  }, 120_000);

  it("lets a rewritten line change the timeline", async () => {
    const result = await stitchSmartEdit({ base: file("base.mp4"), clip: file("line.mp4"), startSec: 8, endSec: 10, audio: "clip" });
    const probe = await probeVideoBuffer(result.video);
    expect(probe.durationSec).toBeGreaterThan(11.8);
    expect(probe.durationSec).toBeLessThan(12.3);
    expect(probe.hasAudio).toBe(true);
  }, 120_000);
});
