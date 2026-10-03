import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoJobOptions, GuidedStoryScript } from "@workspace/db";
import { composeGuidedFootageReuse, planGuidedFootageReuse, validateGuidedFootageReuse } from "./guidedFootageReuse";

const exec = promisify(execFile);
function snapshot(directions: string[]): NonNullable<VideoJobOptions["guidedStory"]> {
  return {
    version: 1, draftId: 1, draftRevision: 1, scriptApprovedAt: "2026-10-03",
    cast: [],
    platform: { id: "reels", aspectRatio: "9:16", width: 1080, height: 1920, safeArea: "center", durationSeconds: directions.length },
    script: {
      title: "Doctor's brand video", scenes: directions.map((visualDirection, index) => ({
        id: `scene_${index + 1}`, startMs: index * 1000, endMs: (index + 1) * 1000,
        visualDirection, roleIds: /end card/i.test(visualDirection) ? [] : ["doctor"],
        lines: [{ id: `line_${index}`, kind: "narration", ownerRoleId: null, text: "Approved narration", startMs: 0, endMs: 1000 }],
      })),
    } as GuidedStoryScript,
    visuals: { version: 1, logo: { path: null, sceneIds: [] }, location: { mode: "none", imagePath: null, description: null } },
  } as NonNullable<VideoJobOptions["guidedStory"]>;
}
const story = () => snapshot([
  "The doctor works at the desk.",
  "The finished doctor reel plays full-screen in a vertical Instagram-style frame, with polished clinic snippets.",
  "Clean branded end card. The KOKAO logo resolves with 'kokao.in'. A small still from the finished reel appears briefly.",
]);

describe("frozen Guided footage dependencies", () => {
  it("binds the reel to real earlier footage and the empty-cast end card to that composed reel", () => {
    expect(planGuidedFootageReuse(story())).toEqual({
      version: 1, scenes: [
        { sceneId: "scene_2", sourceSceneId: "scene_1", kind: "reel", title: "Doctor's brand video", website: null, logoPath: null },
        { sceneId: "scene_3", sourceSceneId: "scene_2", kind: "end_card", title: "KOKAO", website: "kokao.in", logoPath: null },
      ],
    });
  });
  it("does not treat arbitrary videos, reference images, or ordinary cards as this story's output", () => {
    expect(planGuidedFootageReuse(snapshot([
      "The doctor previews a patient video on a laptop.",
      "KOKAO generates scene cards, captions, and reel structure.",
      "The doctor holds a reference photo.",
      "Clean branded end card with the KOKAO logo.",
    ])).scenes).toEqual([]);
  });
  it("requires an earlier character scene and off-screen narration", () => {
    expect(() => planGuidedFootageReuse(snapshot(["The finished reel plays full-screen."]))).toThrow("before any footage");
    const guided = story();
    guided.script.scenes[1].lines[0].kind = "dialogue";
    expect(() => planGuidedFootageReuse(guided)).toThrow("off-screen narration");
  });
  it("plans after final-scene replacement and preserves an explicitly approved logo", () => {
    const guided = story();
    guided.script.scenes.pop();
    expect(planGuidedFootageReuse(guided).scenes).toHaveLength(1);
    const logoStory = story();
    logoStory.visuals!.logo.path = "/objects/10/uploads/logo";
    expect(planGuidedFootageReuse(logoStory).scenes[1].logoPath).toBe("/objects/10/uploads/logo");
  });
  it("also reuses character-free product footage without inventing a cast", () => {
    const guided = story();
    guided.script.scenes.forEach(scene => { scene.roleIds = []; });
    expect(planGuidedFootageReuse(guided).scenes.map(scene => scene.sourceSceneId)).toEqual(["scene_1", "scene_2"]);
  });
  it("rejects missing, forward, cyclic and duplicate links rather than silently generating substitutes", () => {
    for (const sourceSceneId of ["missing", "scene_2", "scene_3"]) {
      const plan = planGuidedFootageReuse(story());
      plan.scenes[0].sourceSceneId = sourceSceneId;
      expect(() => validateGuidedFootageReuse(plan, ["scene_1", "scene_2", "scene_3"])).toThrow();
    }
    const plan = planGuidedFootageReuse(story());
    plan.scenes.push(plan.scenes[0]);
    expect(() => validateGuidedFootageReuse(plan, ["scene_1", "scene_2", "scene_3"])).toThrow();
  });
  it("does not reinterpret historical jobs or their saved clips", async () => {
    const clips = [Buffer.from("legacy")];
    expect(await composeGuidedFootageReuse({ sceneIds: ["legacy"], clips, load: vi.fn() })).toBe(clips);
  });
});

describe("real footage composition (no provider calls)", () => {
  let dir: string;
  let source: Buffer;
  let target: Buffer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "guided-reuse-test-"));
    for (const [name, color, frequency, duration] of [
      ["source", "red", 440, .6], ["target", "blue", 880, 1.2],
    ] as const) {
      await exec("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x288:r=30:d=${duration}`,
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${duration}`, "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", String(duration), join(dir, `${name}.mp4`)]);
    }
    source = await readFile(join(dir, "source.mp4"));
    target = await readFile(join(dir, "target.mp4"));
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function audio(path: string) {
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", path, "-t", "0.5", "-map", "0:a:0", "-f", "s16le", "-"], { encoding: "buffer" });
    return stdout;
  }
  async function pixel(path: string, second: number) {
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(second), "-i", path, "-vf",
      "crop=2:2:80:160,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer" });
    return [...stdout.subarray(0, 3)];
  }
  it("removes invented pixels, holds shorter footage without speeding it up, and retains target audio", async () => {
    const load = vi.fn();
    const clips = await composeGuidedFootageReuse({
      plan: planGuidedFootageReuse(story()), sceneIds: ["scene_1", "scene_2", "scene_3"],
      clips: [source, target, target], load,
    });
    expect(clips[0]).toBe(source);
    expect(load).not.toHaveBeenCalled();
    for (const index of [1, 2]) {
      const path = join(dir, `composed-${index}.mp4`);
      await writeFile(path, clips[index]);
      const [red, green, blue] = await pixel(path, 1);
      expect(red).toBeGreaterThan(200);
      expect(green).toBeLessThan(30);
      expect(blue).toBeLessThan(30);
      expect(await audio(path)).toEqual(await audio(join(dir, "target.mp4")));
      const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
      expect(Number(stdout)).toBeCloseTo(1.2, 1);
    }
    // Recovery starts with the immutable RAW checkpoints, not composed outputs.
    const resumed = await composeGuidedFootageReuse({
      plan: planGuidedFootageReuse(story()), sceneIds: ["scene_1", "scene_2", "scene_3"],
      clips: [source, target, target], load,
    });
    expect(resumed).toEqual(clips);
  }, 30_000);
  it("supports silent source/target clips and fails closed on missing footage", async () => {
    await exec("ffmpeg", ["-y", "-v", "error", "-i", join(dir, "target.mp4"), "-an", "-c:v", "copy", join(dir, "silent.mp4")]);
    const silent = await readFile(join(dir, "silent.mp4"));
    const plan = planGuidedFootageReuse(story());
    plan.scenes.pop();
    const clips = await composeGuidedFootageReuse({ plan, sceneIds: ["scene_1", "scene_2"], clips: [silent, silent], load: vi.fn() });
    expect(clips[1].length).toBeGreaterThan(0);
    await expect(composeGuidedFootageReuse({ plan, sceneIds: ["scene_1", "scene_2"], clips: [Buffer.alloc(0), target], load: vi.fn() })).rejects.toThrow("missing");
  }, 20_000);
});