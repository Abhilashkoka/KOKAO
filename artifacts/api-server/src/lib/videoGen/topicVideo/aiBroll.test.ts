import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import {
  stillToClip,
  buildStillToClipArgs,
  planBrollVisuals,
  animateBrollStills,
  generateBrollStills,
} from "./aiBroll";
import { assignClipsToScenes } from "./visionRank";
import { videoJobUnits } from "../units";

const animateState = vi.hoisted(() => ({
  calls: [] as { prompt: string; mode: string; durationSec: number; image: Buffer }[],
  failFirst: false,
  alwaysFail: false,
}));

const imageGenState = vi.hoisted(() => ({
  results: [] as Buffer[],
  prompts: [] as string[],
}));
vi.mock("../../imageGen", () => ({
  generateImage: vi.fn(async (prompt: string) => {
    imageGenState.prompts.push(prompt);
    const buffer = imageGenState.results.shift();
    if (!buffer) throw new Error("missing mocked image");
    return { buffer, provider: "mock-image", model: "mock-image" };
  }),
}));
vi.mock("../index", () => ({
  generateVideo: vi.fn(
    async (input: { prompt: string; mode: string; durationSec: number; image: { buffer: Buffer } }) => {
      if (animateState.alwaysFail) throw new Error("provider down");
      if (animateState.failFirst && animateState.calls.length === 0) {
        animateState.calls.push({ ...input, image: input.image.buffer });
        throw new Error("transient");
      }
      animateState.calls.push({ ...input, image: input.image.buffer });
      return { buffer: Buffer.from(`clip-${input.prompt}`), provider: "replicate", model: "wan-i2v" };
    },
  ),
}));
// The governed motion instruction is unit-tested in motionPrompt.test.ts;
// here it is pinned so routing assertions don't depend on Prompt Kit state.
vi.mock("../motionPrompt", () => ({
  DEFAULT_MOTION_INSTRUCTION: "Subtle natural motion, cinematic.",
  getMotionInstruction: vi.fn(async () => "Subtle natural motion, cinematic."),
}));

const brollState = vi.hoisted(() => ({
  response: "" as string,
  refinementResponse: null as string | null,
  lastPrompt: "" as string,
  lastRefinementPrompt: "" as string,
  throws: false,
  refinementThrows: false,
}));
vi.mock("../../textGen", () => ({
  getTextGenClient: vi.fn(async () => ({
    provider: "builtin",
    model: "gpt-test",
    client: {
      chat: {
        completions: {
          create: vi.fn(async (args: { messages: { content: string }[] }) => {
            const userPrompt = args.messages[1]!.content;
            if (userPrompt.startsWith("These ")) {
              if (brollState.refinementThrows) throw new Error("refinement unavailable");
              brollState.lastRefinementPrompt = userPrompt;
              const unchanged = [...userPrompt.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]);
              return {
                choices: [
                  {
                    message: {
                      content:
                        brollState.refinementResponse ?? JSON.stringify({ prompts: unchanged }),
                    },
                  },
                ],
              };
            }
            if (brollState.throws) throw new Error("model unavailable");
            brollState.lastPrompt = userPrompt;
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
  brollState.refinementResponse = null;
  brollState.lastPrompt = "";
  brollState.lastRefinementPrompt = "";
  brollState.throws = false;
  brollState.refinementThrows = false;
  promptKitState.logThrows = false;
  promptKitState.logged = 0;
  animateState.calls.length = 0;
  animateState.failFirst = false;
  animateState.alwaysFail = false;
  imageGenState.results.length = 0;
  imageGenState.prompts.length = 0;
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

describe("generateBrollStills duplicate protection", () => {
  async function solid(color: string): Promise<Buffer> {
    return sharp({
      create: { width: 64, height: 64, channels: 3, background: color },
    })
      .png()
      .toBuffer();
  }

  it("regenerates a repeated provider image with a forced fresh-shot prompt", async () => {
    const first = await solid("#cc4433");
    const replacement = await solid("#f5f5f5");
    imageGenState.results.push(first, Buffer.from(first), replacement);

    const result = await generateBrollStills({
      prompts: ["red market stall", "blue office desk"],
      aspectRatio: "9:16",
    });

    expect(result.images).toHaveLength(2);
    expect(result.images[1]!.equals(replacement)).toBe(true);
    expect(imageGenState.prompts).toHaveLength(3);
    expect(imageGenState.prompts[2]).toMatch(/Fresh-shot requirement/);
  });

  it("refuses to use a repeated image when the retry is still a duplicate", async () => {
    const repeated = await solid("#cc4433");
    imageGenState.results.push(repeated, Buffer.from(repeated), Buffer.from(repeated));

    await expect(
      generateBrollStills({
        prompts: ["red market stall", "blue office desk"],
        aspectRatio: "9:16",
      }),
    ).rejects.toThrow(/No duplicate frame was used/);
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
    expect(brollState.lastPrompt).toContain("camera move");
    expect(brollState.lastPrompt).toContain("coverage");
    expect(brollState.lastPrompt).toContain("Treat the full list as an edit plan");
    expect(brollState.lastPrompt).toContain("at least two of");
    expect(brollState.lastPrompt).toContain("quality of light");
  });

  it("polishes the effective scene prompts without changing the raw plan", async () => {
    brollState.response = JSON.stringify({
      style: "warm dawn palette",
      prompts: ["flour on oak", "hands kneading dough"],
    });
    brollState.refinementResponse = JSON.stringify({
      prompts: [
        "macro 50mm view of flour on oak, slow push-in through warm dawn light",
        "medium 35mm frame of hands kneading dough, gentle lateral glide",
      ],
    });
    const result = await planBrollVisuals({
      tenantAiModel: "gpt-test",
      topic: "baking",
      scenes,
    });
    expect(result.prompts).toEqual([
      "macro 50mm view of flour on oak, slow push-in through warm dawn light",
      "medium 35mm frame of hands kneading dough, gentle lateral glide",
    ]);
    expect(result.rawPlan).toEqual({
      style: "warm dawn palette",
      prompts: ["flour on oak", "hands kneading dough"],
    });
    expect(brollState.lastRefinementPrompt).toContain("framing and lens feel");
    expect(brollState.lastRefinementPrompt).toContain("one slow camera move");
    expect(brollState.lastRefinementPrompt).toContain("do not introduce a repeated");
  });

  it("uses the planned prompts unchanged when cinematic refinement fails", async () => {
    brollState.response = JSON.stringify({
      style: "warm dawn palette",
      prompts: ["flour on oak", "hands kneading dough"],
    });
    brollState.refinementThrows = true;
    expect(await plan()).toEqual([
      "flour on oak Shared look across all scenes: warm dawn palette",
      "hands kneading dough Shared look across all scenes: warm dawn palette",
    ]);
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

describe("videoJobUnits for animated AI b-roll", () => {
  it("prices at 3 units per paragraph, between b-roll and character", () => {
    const base = { aspectRatio: "9:16" as const };
    expect(
      videoJobUnits("topic_to_video", { ...base, visualsSource: "ai_video", paragraphCount: 1 }),
    ).toBe(3);
    expect(
      videoJobUnits("topic_to_video", { ...base, visualsSource: "ai_video", paragraphCount: 2 }),
    ).toBe(6);
    // Paragraph count clamps to 1..3, exactly like the other tiers.
    expect(
      videoJobUnits("topic_to_video", { ...base, visualsSource: "ai_video", paragraphCount: 99 }),
    ).toBe(9);
    expect(
      videoJobUnits("topic_to_video", { ...base, visualsSource: "ai_video", paragraphCount: 0 }),
    ).toBe(3);
  });

  it("stacks the music-bed unit and added storyboard scenes like other tiers", () => {
    const base = { aspectRatio: "9:16" as const };
    expect(
      videoJobUnits("topic_to_video", {
        ...base,
        visualsSource: "ai_video",
        paragraphCount: 2,
        musicPrompt: "epic",
      }),
    ).toBe(7);
    expect(
      videoJobUnits("topic_to_video", {
        ...base,
        visualsSource: "ai_video",
        paragraphCount: 1,
        addedScenes: 2,
      }),
    ).toBe(5);
  });
});

describe("animateBrollStills", () => {
  const scenes = [
    { firstCue: 0, lastCue: 0, durationSec: 4, text: "Flour on a table." },
    { firstCue: 1, lastCue: 1, durationSec: 9.5, text: "Kneading the dough." },
  ];

  it("routes every still through image-to-video with the governed motion suffix", async () => {
    const result = await animateBrollStills({
      images: [Buffer.from("still-a"), Buffer.from("still-b")],
      visuals: ["flour drifting onto oak", "hands working dough"],
      scenes,
      aspectRatio: "9:16",
    });
    expect(result.clips).toHaveLength(2);
    expect(result.provider).toBe("replicate");
    expect(result.model).toBe("wan-i2v");
    // Scene map keeps the NARRATION durations; the compositor trims/loops the
    // provider clip to fit, exactly as in character mode.
    expect(result.sceneMap).toEqual([
      { clipIndex: 0, durationSec: 4 },
      { clipIndex: 1, durationSec: 9.5 },
    ]);
    const byPrompt = [...animateState.calls].sort((a, b) => a.prompt.localeCompare(b.prompt));
    expect(byPrompt.map((c) => c.prompt)).toEqual([
      "flour drifting onto oak. Subtle natural motion, cinematic.",
      "hands working dough. Subtle natural motion, cinematic.",
    ]);
    expect(animateState.calls.every((c) => c.mode === "image")).toBe(true);
    // Provider clip lengths follow character mode's discrete durations.
    expect(animateState.calls.map((c) => c.durationSec).sort((a, b) => a - b)).toEqual([5, 10]);
    // The animated frame is exactly the approved still, byte for byte.
    expect(byPrompt.map((c) => c.image.toString())).toEqual(["still-a", "still-b"]);
  });

  it("retries a scene once, then fails the job (refund path)", async () => {
    animateState.failFirst = true;
    const result = await animateBrollStills({
      images: [Buffer.from("still-a")],
      visuals: ["flour"],
      scenes: [scenes[0]!],
      aspectRatio: "9:16",
    });
    expect(result.clips).toHaveLength(1);
    expect(animateState.calls).toHaveLength(2);

    animateState.calls.length = 0;
    animateState.alwaysFail = true;
    await expect(
      animateBrollStills({
        images: [Buffer.from("still-a")],
        visuals: ["flour"],
        scenes: [scenes[0]!],
        aspectRatio: "9:16",
      }),
    ).rejects.toThrow("provider down");
  });

  it("skips completed ai_video scenes and checkpoints only missing scenes", async () => {
    const completed: number[] = [];
    const result = await animateBrollStills({
      images: [Buffer.from("still-a"), Buffer.from("still-b")],
      visuals: ["first", "second"],
      scenes,
      aspectRatio: "9:16",
      savedClips: [Buffer.from("saved-first"), null],
      onCheckpoint: async ({ sceneIndex }) => {
        completed.push(sceneIndex);
      },
    });
    expect(result.clips[0]?.toString()).toBe("saved-first");
    expect(animateState.calls).toHaveLength(1);
    expect(completed).toEqual([1]);
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
