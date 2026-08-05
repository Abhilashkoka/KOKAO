import { describe, it, expect, vi, beforeEach } from "vitest";
import { stillToClip, buildStillToClipArgs, planBrollVisuals } from "./aiBroll";
import { assignClipsToScenes } from "./visionRank";
import { videoJobUnits } from "../units";

const brollState = vi.hoisted(() => ({
  response: "" as string,
  lastPrompt: "" as string,
  throws: false,
}));
vi.mock("../../textGen", () => ({
  getTextGenClient: vi.fn(async () => ({
    provider: "builtin",
    model: "gpt-test",
    client: {
      chat: {
        completions: {
          create: vi.fn(async (args: { messages: { content: string }[] }) => {
            if (brollState.throws) throw new Error("model unavailable");
            brollState.lastPrompt = args.messages[1]!.content;
            return { choices: [{ message: { content: brollState.response } }] };
          }),
        },
      },
    },
  })),
}));

// Governed prompt logging is exercised via a governed template whose logging
// call fails — planning must still succeed (logging is best-effort).
const promptKitState = vi.hoisted(() => ({ logThrows: false, logged: 0 }));
vi.mock("../../promptKit", () => ({
  getGovernedPrompt: vi.fn(async () => ({
    text: "You are a governed art director. Reply with strict JSON only.",
    templateId: 1,
    versionId: 1,
  })),
  logCompiledPrompt: vi.fn(async () => {
    if (promptKitState.logThrows) throw new Error("prompt log db down");
    promptKitState.logged += 1;
  }),
}));

beforeEach(() => {
  brollState.response = "";
  brollState.lastPrompt = "";
  brollState.throws = false;
  promptKitState.logThrows = false;
  promptKitState.logged = 0;
});

// 1x1 red PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function isMp4(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

describe("buildStillToClipArgs", () => {
  it("pins the still input to the pipeline frame rate", () => {
    // The image demuxer defaults to 25fps while the zoompan retimes to 30, so
    // without -framerate the clip landed ~17% short — short enough that the
    // composer loop-filled it and the Ken Burns move visibly restarted
    // mid-scene — and the zoom under-travelled by the same fraction.
    const args = buildStillToClipArgs(3, "9:16", true);
    const inputAt = args.indexOf("-i");
    expect(args.slice(0, inputAt)).toEqual([
      "-y",
      "-framerate",
      "30",
      "-loop",
      "1",
      "-t",
      "3.000",
    ]);
    expect(args[inputAt + 1]).toBe("still.png");
  });
});

describe("planBrollVisuals", () => {
  const scenes = [
    { firstCue: 0, lastCue: 0, durationSec: 4, text: "Flour on a table." },
    { firstCue: 1, lastCue: 1, durationSec: 4, text: "Kneading the dough." },
  ];
  const plan = async () =>
    (await planBrollVisuals({ tenantAiModel: "gpt-test", topic: "baking", scenes })).prompts;
  const rawPlan = async () =>
    (await planBrollVisuals({ tenantAiModel: "gpt-test", topic: "baking", scenes })).rawPlan;

  it("appends one shared look to every scene prompt", async () => {
    // Scene subjects differ on purpose; the look is what has to be constant,
    // otherwise the finished video reads as a stock-photo collage.
    brollState.response = JSON.stringify({
      style: "warm dawn palette, soft window light, 35mm",
      prompts: ["flour drifting onto oak", "hands working dough"],
    });
    expect(await plan()).toEqual([
      "flour drifting onto oak Shared look across all scenes: warm dawn palette, soft window light, 35mm",
      "hands working dough Shared look across all scenes: warm dawn palette, soft window light, 35mm",
    ]);
    expect(brollState.lastPrompt).toContain('{"style": "...", "prompts":');
  });

  it("leaves the scene prompts exactly as they were when no style comes back", async () => {
    for (const response of [
      { style: "   ", prompts: ["a", "b"] },
      { prompts: ["a", "b"] },
      { style: 42, prompts: ["a", "b"] },
      { style: null, prompts: ["a", "b"] },
    ]) {
      brollState.response = JSON.stringify(response);
      expect(await plan()).toEqual(["a", "b"]);
    }
  });

  it("bounds a runaway style clause instead of pasting an essay into every prompt", async () => {
    brollState.response = JSON.stringify({ style: "x".repeat(500), prompts: ["a", "b"] });
    const prompts = await plan();
    expect(prompts[0]).toBe(`a Shared look across all scenes: ${"x".repeat(200)}`);
    expect(prompts[1]).toBe(prompts[0]!.replace(/^a /, "b "));
  });

  it("still falls back to narration text when art direction fails outright", async () => {
    brollState.throws = true;
    expect(await plan()).toEqual([
      "Photorealistic cinematic still: Flour on a table.",
      "Photorealistic cinematic still: Kneading the dough.",
    ]);
  });

  it("still falls back when the response carries a style but no prompts", async () => {
    brollState.response = JSON.stringify({ style: "moody teal grade" });
    expect(await plan()).toEqual([
      "Photorealistic cinematic still: Flour on a table.",
      "Photorealistic cinematic still: Kneading the dough.",
    ]);
  });

  it("surfaces the untouched AI reply for audit, and null when planning fell back", async () => {
    brollState.response = JSON.stringify({ style: "warm", prompts: ["a", "b"] });
    expect(await rawPlan()).toEqual({ style: "warm", prompts: ["a", "b"] });
    brollState.throws = true;
    expect(await rawPlan()).toBeNull();
    brollState.throws = false;
  });

  it("keeps a successful plan (and its raw reply) when prompt logging fails", async () => {
    // Regression: an awaited logging failure used to trip the outer catch,
    // downgrading real prompts to narration fallbacks and dropping rawPlan —
    // which also made the finished job's plan unavailable for reuse.
    promptKitState.logThrows = true;
    brollState.response = JSON.stringify({ style: "warm", prompts: ["a", "b"] });
    const result = await planBrollVisuals({
      tenantAiModel: "gpt-test",
      topic: "baking",
      scenes,
      tenantId: 1, // governed path: logging is attempted
    });
    expect(result.prompts).toEqual([
      "a Shared look across all scenes: warm",
      "b Shared look across all scenes: warm",
    ]);
    expect(result.rawPlan).toEqual({ style: "warm", prompts: ["a", "b"] });
  });

  it("follows a supplied plan without calling the model, through the same clamps", async () => {
    // The model mock would throw if consulted — reuse must never call it.
    brollState.throws = true;
    const supplied = { style: "warm dawn", prompts: ["flour close-up", "kneading hands"] };
    const result = await planBrollVisuals({
      tenantAiModel: "gpt-test",
      topic: "baking",
      scenes,
      suppliedPlan: supplied,
    });
    expect(result.prompts).toEqual([
      "flour close-up Shared look across all scenes: warm dawn",
      "kneading hands Shared look across all scenes: warm dawn",
    ]);
    // The reused plan becomes the new job's audit record.
    expect(result.rawPlan).toEqual(supplied);
  });

  it("pads a supplied plan that is shorter than the scene list with narration fallbacks", async () => {
    const result = await planBrollVisuals({
      tenantAiModel: "gpt-test",
      topic: "baking",
      scenes,
      suppliedPlan: { prompts: ["flour close-up"] },
    });
    expect(result.prompts).toEqual([
      "flour close-up",
      "Photorealistic cinematic still: Kneading the dough.",
    ]);
  });

  it("rejects a supplied plan with no prompts instead of silently falling back", async () => {
    await expect(
      planBrollVisuals({
        tenantAiModel: "gpt-test",
        topic: "baking",
        scenes,
        suppliedPlan: { style: "moody" },
      }),
    ).rejects.toThrow(/saved plan/i);
  });
});

describe("stillToClip", () => {
  it("turns a still image into a Ken Burns MP4 with real ffmpeg", async () => {
    const zoomIn = await stillToClip(PNG_1PX, 1.5, "9:16", true);
    expect(isMp4(zoomIn)).toBe(true);
    const zoomOut = await stillToClip(PNG_1PX, 1.5, "1:1", false);
    expect(isMp4(zoomOut)).toBe(true);
  }, 180_000);
});

describe("videoJobUnits for AI b-roll", () => {
  it("prices at 2 units per paragraph, half the character rate", () => {
    const base = { aspectRatio: "9:16" as const };
    expect(videoJobUnits("topic_to_video", { ...base, visualsSource: "ai", paragraphCount: 1 })).toBe(2);
    expect(videoJobUnits("topic_to_video", { ...base, visualsSource: "ai", paragraphCount: 3 })).toBe(6);
    expect(
      videoJobUnits("topic_to_video", { ...base, visualsSource: "character", paragraphCount: 1 }),
    ).toBe(4);
    expect(videoJobUnits("topic_to_video", { ...base, visualsSource: "stock", paragraphCount: 3 })).toBe(1);
  });

  it("adds one unit for an AI-composed music bed (unless a track is uploaded)", () => {
    const base = { aspectRatio: "9:16" as const };
    expect(videoJobUnits("topic_to_video", { ...base, musicPrompt: "lofi" })).toBe(2);
    expect(videoJobUnits("slideshow", { ...base, musicPrompt: "lofi" })).toBe(2);
    expect(
      videoJobUnits("slideshow", { ...base, musicPrompt: "lofi", musicPath: "/objects/1/u/t.mp3" }),
    ).toBe(1);
    expect(
      videoJobUnits("topic_to_video", {
        ...base,
        visualsSource: "ai",
        paragraphCount: 2,
        musicPrompt: "epic",
      }),
    ).toBe(5);
    expect(videoJobUnits("text_to_video", { ...base, musicPrompt: "lofi" })).toBe(2);
    expect(videoJobUnits("image_to_video", { ...base, musicPrompt: "lofi" })).toBe(2);
    expect(
      videoJobUnits("image_to_video", {
        ...base,
        musicPrompt: "lofi",
        musicPath: "/objects/1/u/t.mp3",
      }),
    ).toBe(1);
  });
});

describe("assignClipsToScenes fail-soft guarantees", () => {
  const clip = (thumbnailUrl: string | null) => ({
    url: "https://example.com/a.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    provider: "pexels" as const,
    thumbnailUrl,
  });

  it("returns null when there are not enough thumbnails to rank", async () => {
    expect(
      await assignClipsToScenes({
        tenantAiModel: "auto",
        topic: "coffee",
        sceneTexts: ["A", "B"],
        candidates: [clip(null), clip(null)],
      }),
    ).toBeNull();
    expect(
      await assignClipsToScenes({
        tenantAiModel: "auto",
        topic: "coffee",
        sceneTexts: [],
        candidates: [clip("https://example.com/t.jpg"), clip("https://example.com/t2.jpg")],
      }),
    ).toBeNull();
  });
});
