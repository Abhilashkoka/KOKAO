import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { appendEndCard, assembleScreenDemoScript, buildScreenDemoScriptPrompt,
  demoWordBudget, endCardLines, endCardTextColor, extractDemoFrames, fitScreenDemoClip,
  probeScreenRecording, renderEndCard, repairScreenDemoScript, resolveScreenDemoScript,
  screenDemoBeatMaxSeconds, ScreenDemoInputError, SCREEN_DEMO_SPOKEN_LINE_MAX_CHARS,
  toSingleSpokenLine, userScreenDemoScriptIssues, writeScreenDemoScript } from "./screenDemo";
import { splitIntoSentences } from "./topicVideo/narration";
import { assertHybridStoryBeatPlan, planHybridStoryBeats } from "./hybridStory";

const exec = promisify(execFile);
async function hasFfmpeg() {
  try {
    await Promise.all([exec("ffmpeg", ["-version"]), exec("ffprobe", ["-version"])]);
    return true;
  } catch { return false; }
}
const FFMPEG = await hasFfmpeg();
async function mediaDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "screen-demo-test-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function recording(seconds: number, width: number, height: number, audio = false) {
  return mediaDir(async (dir) => {
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i",
      `testsrc2=s=${width}x${height}:r=30:d=${seconds}`,
      ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac"] : []), "-shortest", "rec.mp4"],
    { cwd: dir, timeout: 60_000 });
    return readFile(join(dir, "rec.mp4"));
  });
}
function probe(video: Buffer) {
  return mediaDir(async (dir) => {
    await writeFile(join(dir, "v.mp4"), video);
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams",
      "-show_format", "-of", "json", "v.mp4"], { cwd: dir });
    const parsed = JSON.parse(stdout);
    const picture = parsed.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    return { width: picture.width, height: picture.height,
      durationSec: Number(parsed.format.duration),
      hasAudio: parsed.streams.some((s: { codec_type: string }) => s.codec_type === "audio") };
  });
}
function pixel(video: Buffer, second: number, x: number, y: number) {
  return mediaDir(async (dir) => {
    await writeFile(join(dir, "v.mp4"), video);
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(second),
      "-i", "v.mp4", "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`,
      "-f", "rawvideo", "pipe:1"], { cwd: dir, encoding: "buffer" });
    return stdout as unknown as Buffer;
  });
}

describe("walkthrough script", () => {
  it("keeps one character cue and clips words on boundaries", () => {
    expect(toSingleSpokenLine("Meet Dr. Rao. She saves 3.5 hours a week!"))
      .toBe("Meet Dr Rao She saves 3 point 5 hours a week!");
    const line = toSingleSpokenLine("word ".repeat(60));
    expect(line.length).toBeLessThanOrEqual(SCREEN_DEMO_SPOKEN_LINE_MAX_CHARS);
    expect(splitIntoSentences(line)).toHaveLength(1);
  });
  it("repairs word budgets and builds three beats", () => {
    const parts = repairScreenDemoScript({ intro: "Paperwork eats your evenings.",
      steps: ["Open it.", "Tap save.", "Your report is ready to send.",
        ...Array(40).fill("This step describes one screen in about ten plain words.")],
    }, { recordingDurationSec: 30, brandName: "KOKAO" });
    expect(parts.steps[0]).toBe("Open it, tap save.");
    expect(parts.closing).toBe("Try KOKAO today.");
    expect(parts.steps.join(" ").split(/\s+/u).length).toBeLessThanOrEqual(Math.ceil(demoWordBudget(30) * 1.15));
    const beats = planHybridStoryBeats({ pattern: [
      { kind: "character_opening", maxDurationSeconds: 10 },
      { kind: "screen_demo", maxDurationSeconds: 120 },
      { kind: "character_closing", maxDurationSeconds: 10 },
    ], sentences: splitIntoSentences(assembleScreenDemoScript(parts)) });
    expect(beats.map((beat) => beat.type)).toEqual(["character_speaking", "screen_demo", "character_speaking"]);
    expect(() => assertHybridStoryBeatPlan(beats)).not.toThrow();
  });
  it("validates user scripts and prompt grounding", () => {
    expect(userScreenDemoScriptIssues("One sentence.")).toHaveLength(1);
    expect(userScreenDemoScriptIssues("Problem solved. Open the dashboard to book a patient. Try KOKAO today.")).toEqual([]);
    const prompt = buildScreenDemoScriptPrompt({ brief: "Clinics", recordingDurationSec: 40,
      hasFrames: true, cta: "Book a demo" });
    expect(prompt.system).toContain(`about ${demoWordBudget(40)} words`);
    expect(prompt.system).toContain("Do not invent features");
    expect(prompt.user).toContain("Book a demo");
    expect(screenDemoBeatMaxSeconds(40)).toBe(70);
    expect(screenDemoBeatMaxSeconds(590)).toBe(600);
  });
  it("falls back only for explicit image capability errors", async () => {
    const response = { choices: [{ message: { content: JSON.stringify({
      intro: "Scheduling should not take ten clicks.",
      steps: ["Open the calendar.", "Drag a slot to book it."],
      closing: "Try Kloud Klinix today.",
    }) } }] };
    const create = vi.fn().mockRejectedValueOnce(new Error("model does not support image input"))
      .mockResolvedValueOnce(response);
    const client = { chat: { completions: { create } } } as never;
    const result = await writeScreenDemoScript({ client, model: "m", brief: "b",
      recordingDurationSec: 20, frames: [Buffer.from("jpg")] });
    expect(result.usedFrames).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[0]![0])).toContain("image_url");
    expect(JSON.stringify(create.mock.calls[1]![0])).not.toContain("image_url");
    create.mockReset().mockRejectedValue(new Error("network timeout"));
    await expect(writeScreenDemoScript({ client, model: "m", brief: "b",
      recordingDurationSec: 20, frames: [Buffer.from("jpg")] })).rejects.toThrow("network timeout");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not suppress frame extraction failure", async () => {
    await expect(resolveScreenDemoScript({ screenDemo: { scriptMode: "auto", recordingDurationSec: 20 },
      brief: "App", loadRecording: async () => Buffer.from("not a video"),
      textClient: async () => { throw new Error("should not call"); } })).rejects.toThrow();
  });
  it("chooses readable card ink and ignores empty lines", () => {
    expect(endCardTextColor("#F4E1F0")).toBe("0x1F2937");
    expect(endCardTextColor("#1E1B4B")).toBe("0xFFFFFF");
    expect(endCardLines({ brandName: "KOKAO", tagline: " ", cta: "kokao.app" })
      .map((line) => line.key)).toEqual(["brand", "cta"]);
  });
});

describe.skipIf(!FFMPEG)("walkthrough media", () => {
  it("rejects short recording, extracts real frames", async () => {
    await expect(probeScreenRecording(await recording(2, 320, 240))).rejects.toBeInstanceOf(ScreenDemoInputError);
    expect(await extractDemoFrames(await recording(5, 320, 240), 2)).toHaveLength(2);
  }, 60_000);
  it("letterboxes rather than cropping, preserves recording duration and removes source audio", async () => {
    const rec = await recording(6, 1280, 720, true);
    const clip = await fitScreenDemoClip({ recording: rec, targetSec: 3,
      aspectRatio: "9:16", background: "#E8DFF5" });
    expect(await probe(clip)).toMatchObject({ width: 1080, height: 1920, hasAudio: false });
    expect((await probe(clip)).durationSec).toBeGreaterThan(5.8);
    const margin = await pixel(clip, 1, 540, 40);
    expect(Math.abs(margin[0]! - 0xe8)).toBeLessThan(12);
    expect(Math.abs(margin[2]! - 0xf5)).toBeLessThan(12);
  }, 120_000);
  it("holds the last frame when narration runs longer", async () => {
    const clip = await fitScreenDemoClip({ recording: await recording(5, 720, 1280),
      targetSec: 8, aspectRatio: "9:16" });
    expect((await probe(clip)).durationSec).toBeGreaterThan(7.8);
  }, 120_000);
  it("renders every animation with logo and appends audio", async () => {
    const logo = await mediaDir(async (dir) => {
      await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x6D28D9:s=400x160",
        "-frames:v", "1", "logo.png"], { cwd: dir });
      return readFile(join(dir, "logo.png"));
    });
    for (const animation of ["fade_up", "logo_scale", "slide_in"] as const) {
      const card = await renderEndCard({ width: 1280, height: 720, durationSec: 3,
        animation, background: "#FCE7F3", logo, brandName: "KOKAO",
        tagline: "Your brand, on video", cta: "kokao.app" });
      expect(await probe(card)).toMatchObject({ width: 1280, height: 720, hasAudio: true });
      expect((await pixel(card, 2.5, 640, 250))[0]).toBeLessThan(160);
    }
    const main = await recording(4, 1280, 720, true);
    const card = await renderEndCard({ width: 1280, height: 720,
      durationSec: 3, animation: "fade_up", brandName: "KOKAO" });
    const joined = await probe(await appendEndCard(main, card));
    expect(joined.durationSec).toBeGreaterThan(6.8);
    expect(joined.hasAudio).toBe(true);
  }, 240_000);
});