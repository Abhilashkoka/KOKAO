import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildWav, parseWav } from "./narration";
import type { ScriptScene } from "./characterScenes";

const generateVideo = vi.fn();
const lipSyncClip = vi.fn();
const trimClipToStart = vi.fn();

vi.mock("../index", () => ({
  generateVideo: (...args: unknown[]) => generateVideo(...args),
}));
vi.mock("../lipSyncClip", () => ({
  lipSyncClip: (...args: unknown[]) => lipSyncClip(...args),
}));
vi.mock("../postprocess", () => ({
  trimClipToStart: (...args: unknown[]) => trimClipToStart(...args),
}));
vi.mock("../motionPrompt", () => ({
  getMotionInstruction: async () => "Subtle natural motion, cinematic.",
}));

const FORMAT = {
  channels: 1,
  sampleRate: 24_000,
  bitsPerSample: 16,
  byteRate: 48_000,
  blockAlign: 2,
};

/** Track whose sample value encodes its own second, so slices are traceable. */
function rampTrack(seconds: number): Buffer {
  const pcm = Buffer.alloc(FORMAT.byteRate * seconds);
  for (let i = 0; i < pcm.length / FORMAT.blockAlign; i++) {
    pcm.writeInt16LE((Math.floor(i / FORMAT.sampleRate) + 1) * 1000, i * FORMAT.blockAlign);
  }
  return buildWav(FORMAT, pcm);
}

const SCENES: ScriptScene[] = [
  { firstCue: 0, lastCue: 0, durationSec: 2, text: "one" },
  { firstCue: 1, lastCue: 1, durationSec: 2, text: "two" },
  { firstCue: 2, lastCue: 2, durationSec: 2, text: "three" },
];

const PLAN = SCENES.map((_, i) => ({ visual: `scene ${i}`, outfitId: 1 }));
const KEYFRAMES = SCENES.map((_, i) => Buffer.from(`keyframe-${i}`));

beforeEach(() => {
  generateVideo.mockReset();
  lipSyncClip.mockReset();
  trimClipToStart.mockReset();
  generateVideo.mockImplementation(async () => ({
    buffer: Buffer.from("raw-clip"),
    provider: "replicate",
    model: "wan-video/wan-2.2-i2v-fast",
  }));
  trimClipToStart.mockImplementation(async (video: Buffer) => video);
  lipSyncClip.mockImplementation(async () => ({
    buffer: Buffer.from("synced-clip"),
    provider: "replicate",
    model: "bytedance/latentsync",
  }));
});

afterEach(() => {
  vi.resetModules();
});

async function animate(lipSync: { wav: Buffer } | null) {
  const { animateSceneKeyframes } = await import("./characterScenes");
  return animateSceneKeyframes({
    keyframes: KEYFRAMES,
    plan: PLAN,
    scenes: SCENES,
    aspectRatio: "9:16",
    lipSync,
  });
}

describe("character scene lip sync", () => {
  it("gives each shot only its own span of the narration", async () => {
    await animate({ wav: rampTrack(6) });
    expect(lipSyncClip).toHaveBeenCalledTimes(3);
    // Scenes tile the track in order: 0-2s, 2-4s, 4-6s. The ramp encodes the
    // second, so the first sample of each slice names where it came from.
    // Rounded, not exact: the lip-sync noise floor rides under every slice, so
    // a sample is within ~33 of its ramp value rather than equal to it.
    const seconds = lipSyncClip.mock.calls.map(
      ([args]) =>
        Math.round(parseWav((args as { audio: Buffer }).audio).pcm.readInt16LE(0) / 1000),
    );
    expect(seconds).toEqual([1, 3, 5]);
  });

  it("cuts every shot to its scene length before syncing", async () => {
    await animate({ wav: rampTrack(6) });
    expect(trimClipToStart.mock.calls.map(([, target]) => target)).toEqual([2, 2, 2]);
  });

  it("flags synced shots so the compositor will not move them", async () => {
    const out = await animate({ wav: rampTrack(6) });
    expect(out.sceneMap.every((scene) => scene.lipSynced === true)).toBe(true);
    expect(out.clips.every((clip) => clip.toString() === "synced-clip")).toBe(true);
  });

  it("ships the unsynced shot when the model fails, and does not flag it", async () => {
    lipSyncClip.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const out = await animate({ wav: rampTrack(6) });
    // The shot is already generated and already paid for: an unsynced shot
    // beats failing the whole job.
    expect(out.clips).toHaveLength(3);
    expect(out.sceneMap.some((scene) => scene.lipSynced)).toBe(false);
  });

  it("does nothing when lip sync is off", async () => {
    const out = await animate(null);
    expect(lipSyncClip).not.toHaveBeenCalled();
    expect(trimClipToStart).not.toHaveBeenCalled();
    expect(out.sceneMap.some((scene) => scene.lipSynced)).toBe(false);
  });
});
