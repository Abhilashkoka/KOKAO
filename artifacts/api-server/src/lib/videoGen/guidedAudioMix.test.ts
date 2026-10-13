import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuidedStoryReferenceLibrary, GuidedStoryScript, VideoJobOptions } from "@workspace/db";
import {
  applyGuidedFinishing,
  guidedFinishingArgs,
  guidedSceneWindows,
  planGuidedFinishing,
  pruneGuidedAudioChoices,
  validateGuidedAudioChoices,
  GuidedAudioChoicesError,
} from "./guidedAudioMix";
import { referenceDigest } from "./topicVideo/referenceImages";

const script: GuidedStoryScript = {
  version: 1,
  title: "Morning",
  logline: "A shop opens.",
  runtimeSeconds: 8,
  roles: [{ id: "owner", name: "Ravi", description: "Shop owner" }],
  scenes: [
    { id: "s1", startMs: 0, endMs: 3000, visualDirection: "Shutter opens.", roleIds: ["owner"], lines: [{ id: "l1", ownerRoleId: null, kind: "narration", text: "Every morning.", startMs: 0, endMs: 2500 }] },
    { id: "s2", startMs: 3000, endMs: 8000, visualDirection: "Customers arrive.", roleIds: ["owner"], referenceIds: ["r2"], lines: [{ id: "l2", ownerRoleId: null, kind: "narration", text: "Fresh bread.", startMs: 3000, endMs: 7000 }] },
  ],
  warnings: [],
};

function ref(id: string, handle: string, use: GuidedStoryReferenceLibrary["items"][number]["use"], media: GuidedStoryReferenceLibrary["items"][number]["media"], path = `/objects/1/uploads/${handle}`, sha256 = "x") {
  return { id, handle, label: handle, media, use, path, sha256, mimeType: "audio/mpeg", byteLength: 1, durationSeconds: 10, notes: "", aiDescription: null, transcript: null, documentText: null, voiceFor: null, rightsConfirmed: true };
}

const library: GuidedStoryReferenceLibrary = {
  version: 1,
  items: [ref("r1", "bgm", "music", "audio"), ref("r2", "shop", "footage", "video"), ref("r3", "ding", "sfx", "audio"), ref("r4", "logo", "logo", "image")],
};

describe("guided audio choices", () => {
  it("accepts music, voiceover and sfx placements on known scenes", () => {
    const choices = validateGuidedAudioChoices(
      { items: [{ referenceId: "r3", sceneId: "s2", startSeconds: 0.5, endSeconds: null, volume: 1 }] },
      { references: library, script },
    );
    expect(choices?.items[0]).toMatchObject({ referenceId: "r3", sceneId: "s2", startSeconds: 0.5, duckUnderSpeech: false });
  });

  it("rejects non-audio uploads, unknown scenes and inverted windows", () => {
    expect(() => validateGuidedAudioChoices({ items: [{ referenceId: "r4", sceneId: null }] }, { references: library, script }))
      .toThrow(GuidedAudioChoicesError);
    expect(() => validateGuidedAudioChoices({ items: [{ referenceId: "r1", sceneId: "nope" }] }, { references: library, script }))
      .toThrow(/not in the script/);
    expect(() => validateGuidedAudioChoices({ items: [{ referenceId: "r1", sceneId: null, startSeconds: 5, endSeconds: 2 }] }, { references: library, script }))
      .toThrow(/end after/);
  });

  it("prunes placements whose scene or upload disappeared", () => {
    const pruned = pruneGuidedAudioChoices(
      { version: 1, items: [
        { referenceId: "r1", sceneId: null, startSeconds: 0, endSeconds: null, volume: 0.3, duckUnderSpeech: true, replaceGeneratedAudio: false },
        { referenceId: "r3", sceneId: "gone", startSeconds: 0, endSeconds: null, volume: 1, duckUnderSpeech: false, replaceGeneratedAudio: false },
      ] },
      { references: library, script },
    );
    expect(pruned?.items.map((item) => item.referenceId)).toEqual(["r1"]);
  });
});

describe("guided finishing plan", () => {
  it("scales script windows to the actual render and prefers the rendered timeline", () => {
    const scaled = guidedSceneWindows(script, 10);
    expect(scaled.get("s2")).toEqual({ startSec: 3.75, endSec: 10 });
    const rendered = guidedSceneWindows(script, 16, { version: 1, scenes: [{ sceneId: "s2", startSec: 2.5, endSec: 9 }] });
    expect(rendered.get("s2")).toEqual({ startSec: 2.5, endSec: 9 });
  });

  it("covers tagged footage scenes and defaults music under the whole video", () => {
    const plan = planGuidedFinishing({ script, references: library } as unknown as NonNullable<VideoJobOptions["guidedStory"]>, 8);
    expect(plan?.footage).toEqual([expect.objectContaining({ handle: "shop", startSec: 3, endSec: 8 })]);
    expect(plan?.layers).toEqual([expect.objectContaining({ handle: "bgm", startSec: 0, endSec: null, duck: true })]);
  });

  it("anchors placements to their scene start", () => {
    const plan = planGuidedFinishing({
      script,
      references: library,
      audioChoices: { version: 1, items: [{ referenceId: "r3", sceneId: "s2", startSeconds: 1, endSeconds: 2, volume: 0.8, duckUnderSpeech: false, replaceGeneratedAudio: false }] },
    } as unknown as NonNullable<VideoJobOptions["guidedStory"]>, 8);
    expect(plan?.layers.find((layer) => layer.handle === "ding")).toMatchObject({ startSec: 4, endSec: 5, volume: 0.8 });
  });

  it("copies video when only audio changes", () => {
    const args = guidedFinishingArgs({
      plan: { version: 1, footage: [], layers: [{ handle: "bgm", use: "music", path: "p", sha256: "s", startSec: 0, endSec: null, volume: 0.3, duck: true, replace: false }] },
      base: { file: "base.mp4", durationSec: 8, width: 360, height: 640, hasAudio: true },
      footageFiles: [],
      layerFiles: ["bgm.mp3"],
      output: "out.mp4",
    });
    expect(args).toContain("copy");
    expect(args.join(" ")).toContain("sidechaincompress");
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

describe.skipIf(!hasFfmpeg)("applyGuidedFinishing (ffmpeg)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "guided-mix-test-"));
    const run = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
    run(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=300:duration=8", "-c:v", "libx264", "-c:a", "aac", "-shortest", join(dir, "base.mp4")]);
    run(["-f", "lavfi", "-i", "sine=frequency=800:duration=20", join(dir, "music.mp3")]);
    run(["-f", "lavfi", "-i", "sine=frequency=500:duration=3", join(dir, "vo.wav")]);
    run(["-f", "lavfi", "-i", "smptebars=size=1280x720:rate=25:duration=2", "-c:v", "libx264", join(dir, "foot.mp4")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string) => readFileSync(join(dir, name));

  it("overlays footage and mixes music + voiceover into a same-length video", async () => {
    const out = await applyGuidedFinishing({
      buffer: file("base.mp4"),
      plan: {
        version: 1,
        footage: [{ handle: "shop", path: "foot.mp4", sha256: referenceDigest(file("foot.mp4")), startSec: 2, endSec: 5 }],
        layers: [
          { handle: "bgm", use: "music", path: "music.mp3", sha256: referenceDigest(file("music.mp3")), startSec: 0, endSec: null, volume: 0.3, duck: true, replace: false },
          { handle: "vo", use: "voiceover", path: "vo.wav", sha256: referenceDigest(file("vo.wav")), startSec: 4, endSec: 7, volume: 1, duck: false, replace: true },
        ],
      },
      load: async (path) => file(path),
    });
    writeFileSync(join(dir, "out.mp4"), out);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", join(dir, "out.mp4")]).toString();
    const parsed = JSON.parse(probe) as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number }> };
    expect(Number(parsed.format.duration)).toBeGreaterThan(7.8);
    expect(Number(parsed.format.duration)).toBeLessThan(8.3);
    expect(parsed.streams.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    expect(parsed.streams.find((stream) => stream.codec_type === "video")?.width).toBe(360);
  }, 120_000);

  it("refuses an upload whose bytes changed after approval", async () => {
    await expect(applyGuidedFinishing({
      buffer: file("base.mp4"),
      plan: { version: 1, footage: [], layers: [{ handle: "bgm", use: "music", path: "music.mp3", sha256: "0".repeat(64), startSec: 0, endSec: null, volume: 0.3, duck: false, replace: false }] },
      load: async (path) => file(path),
    })).rejects.toThrow(/@bgm changed/);
  }, 60_000);
});
