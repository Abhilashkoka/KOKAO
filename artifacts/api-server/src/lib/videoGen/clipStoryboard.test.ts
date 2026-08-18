import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VideoGeneration, VideoStoryboard } from "@workspace/db";
import {
  clampSceneDuration,
  clipDurationBounds,
  clipShotCount,
  clipStoryboardSource,
  clipStoryboardTotalSec,
  planClipStoryboard,
  polishStoryboardPrompts,
  renderClipStoryboard,
} from "./clipStoryboard";
import { videoJobUnits } from "./units";

const state = vi.hoisted(() => ({
  /** JSON the shot-splitter gets back, or "" to make the call throw. */
  shotReply: "",
  splitThrows: false,
  splitPrompt: "",
  systemPrompt: "",
  llmCalls: 0,
  keyframeFailsOn: null as string | null,
  keyframePrompts: [] as string[],
  keyframeRefs: [] as (string | null)[],
  generateCalls: [] as { mode: string; prompt: string; durationSec: number; hasImage: boolean }[],
  slideshowCall: null as {
    slideDurationsSec?: number[] | null;
    slideCaptions?: string[] | null;
    imageCount: number;
  } | null,
  concatCount: 0,
  musicMixed: false,
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: 1, aiModel: "auto" }] }),
        }),
      }),
    },
  };
});

vi.mock("../textGen", () => ({
  getTextGenClient: vi.fn(async () => ({
    provider: "builtin",
    model: "gpt-test",
    client: {
      chat: {
        completions: {
          create: vi.fn(async (args: { messages: { content: string }[] }) => {
            state.llmCalls += 1;
            if (state.splitThrows) throw new Error("model unavailable");
            state.systemPrompt = args.messages[0]!.content;
            state.splitPrompt = args.messages[1]!.content;
            return { choices: [{ message: { content: state.shotReply } }] };
          }),
        },
      },
    },
  })),
}));

// Prompt Template Kit: governed text per flow key (null = no active template),
// plus a trace of what was fetched/logged.
const pk = vi.hoisted(() => ({
  governedByFlow: {} as Record<string, string | undefined>,
  getCalls: [] as string[],
  logged: [] as string[],
}));
vi.mock("../promptKit", () => ({
  getGovernedPrompt: vi.fn(async (req: { flowKey: string }) => {
    pk.getCalls.push(req.flowKey);
    const text = pk.governedByFlow[req.flowKey];
    return text ? { text, templateId: 1, versionId: 1 } : null;
  }),
  logCompiledPrompt: vi.fn(async (input: { flowKey: string }) => {
    pk.logged.push(input.flowKey);
  }),
}));

vi.mock("../characters", () => ({
  getCharacterDetail: vi.fn(async () => ({
    character: { id: 7, name: "Mira" },
    outfits: [{ id: 3, referenceImagePath: "/objects/1/c/mira-red.png" }],
  })),
  resolveOutfit: vi.fn(() => ({ id: 3, referenceImagePath: "/objects/1/c/mira-red.png" })),
  loadReferenceImage: vi.fn(async (path: string) => ({ buffer: Buffer.from(path), mimeType: "image/png" })),
  generateSceneKeyframe: vi.fn(
    async (
      _character: unknown,
      _outfit: unknown,
      visual: string,
      _aspect: string,
      reference: { buffer: Buffer } | null,
    ) => {
      state.keyframePrompts.push(visual);
      state.keyframeRefs.push(reference ? reference.buffer.toString() : null);
      if (state.keyframeFailsOn === visual) throw new Error("image model down");
      return { buffer: Buffer.from(`frame:${visual}`) };
    },
  ),
}));

vi.mock("./index", () => ({
  generateVideo: vi.fn(
    async (args: { mode: string; prompt: string; durationSec: number; image?: unknown }) => {
      state.generateCalls.push({
        mode: args.mode,
        prompt: args.prompt,
        durationSec: args.durationSec,
        hasImage: args.image != null,
      });
      return { buffer: Buffer.from(`clip:${args.prompt}`), provider: "replicate", model: "veo-test" };
    },
  ),
}));

vi.mock("./postprocess", () => ({
  normalizeVideo: vi.fn(async (buffer: Buffer) => buffer),
  enforceClipDuration: vi.fn(async (buffer: Buffer) => buffer),
  concatClips: vi.fn(async (clips: Buffer[]) => {
    state.concatCount = clips.length;
    return Buffer.concat(clips);
  }),
  mixMusicIntoVideo: vi.fn(async (buffer: Buffer) => {
    state.musicMixed = true;
    return buffer;
  }),
}));

vi.mock("./slideshow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slideshow")>();
  return {
    ...actual,
    renderSlideshow: vi.fn(
      async (input: {
        images: Buffer[];
        slideDurationsSec?: number[] | null;
        slideCaptions?: string[] | null;
      }) => {
        state.slideshowCall = {
          slideDurationsSec: input.slideDurationsSec,
          slideCaptions: input.slideCaptions,
          imageCount: input.images.length,
        };
        return Buffer.from("slideshow");
      },
    ),
  };
});

beforeEach(() => {
  state.shotReply = "";
  state.splitThrows = false;
  state.splitPrompt = "";
  state.systemPrompt = "";
  state.llmCalls = 0;
  pk.governedByFlow = {};
  pk.getCalls = [];
  pk.logged = [];
  state.keyframeFailsOn = null;
  state.keyframePrompts = [];
  state.keyframeRefs = [];
  state.generateCalls = [];
  state.slideshowCall = null;
  state.concatCount = 0;
  state.musicMixed = false;
});

function makeJob(overrides: Partial<VideoGeneration>): VideoGeneration {
  return {
    id: 42,
    tenantId: 1,
    engine: "text_to_video",
    prompt: "A barista pulling an espresso shot",
    sourceImagePaths: null,
    options: { aspectRatio: "9:16" },
    ...overrides,
  } as unknown as VideoGeneration;
}

function board(overrides: Partial<VideoStoryboard>): VideoStoryboard {
  return {
    version: 1,
    visualsSource: "prompt",
    timelineLocked: false,
    durationBounds: { minSec: 3, maxSec: 10 },
    model: null,
    provider: null,
    regenerations: 0,
    narration: null,
    scenes: [],
    ...overrides,
  } as VideoStoryboard;
}

const plan = (job: VideoGeneration, source: Parameters<typeof planClipStoryboard>[0]["source"]) =>
  planClipStoryboard({
    job,
    source,
    aspectRatio: "9:16",
    upload: async (bytes) => `/objects/1/sb/${bytes.toString()}.png`,
  });

describe("clip storyboard pacing rules", () => {
  it("bounds each plan kind to what its renderer can actually deliver", () => {
    // The "one image every three to five seconds" rule lives here: AI clips
    // cannot read as motion under 3s and no provider will do a single take past
    // 10s, while slides are bounded by the encoder's own clamps.
    expect(clipDurationBounds("character")).toEqual({ minSec: 3, maxSec: 10 });
    expect(clipDurationBounds("prompt")).toEqual({ minSec: 3, maxSec: 10 });
    expect(clipDurationBounds("photo")).toEqual({ minSec: 3, maxSec: 10 });
    expect(clipDurationBounds("slide")).toEqual({ minSec: 1, maxSec: 10 });
    // Topic b-roll is cut against narration, so it has no free timeline at all.
    expect(clipDurationBounds("ai")).toBeNull();
  });

  it("clamps an edited length instead of rejecting it", () => {
    const slides = board({ visualsSource: "slide", durationBounds: { minSec: 1, maxSec: 10 } });
    expect(clampSceneDuration(slides, 30)).toBe(10);
    expect(clampSceneDuration(slides, 0.2)).toBe(1);
    expect(clampSceneDuration(slides, 4.44)).toBe(4.4);
    // A plan stored before bounds existed still clamps, from its source.
    const legacy = board({ visualsSource: "character", durationBounds: null });
    expect(clampSceneDuration(legacy, 1)).toBe(3);
    expect(clampSceneDuration(legacy, 99)).toBe(10);
    // Narration-timed plans have no bounds to clamp into, so lengths pass through.
    expect(clampSceneDuration(board({ visualsSource: "ai", durationBounds: null }), 2.5)).toBe(2.5);
    expect(clampSceneDuration(slides, Number.NaN)).toBe(1);
  });

  it("pins shot count into the funded range", () => {
    expect(clipShotCount(undefined)).toBe(1);
    expect(clipShotCount(0)).toBe(1);
    expect(clipShotCount(-4)).toBe(1);
    expect(clipShotCount(2.7)).toBe(2);
    expect(clipShotCount(5)).toBe(5);
    expect(clipShotCount(10)).toBe(10);
    expect(clipShotCount(99)).toBe(10);
    expect(clipShotCount(Number.NaN)).toBe(1);
  });

  it("maps each engine to the plan kind it produces", () => {
    expect(clipStoryboardSource(makeJob({ engine: "text_to_video" }))).toBe("prompt");
    expect(
      clipStoryboardSource(
        makeJob({ engine: "text_to_video", options: { aspectRatio: "9:16", characterId: 7 } }),
      ),
    ).toBe("character");
    expect(clipStoryboardSource(makeJob({ engine: "image_to_video" }))).toBe("photo");
    expect(clipStoryboardSource(makeJob({ engine: "slideshow" }))).toBe("slide");
    // Topic mode plans through its own narration-aware path.
    expect(clipStoryboardSource(makeJob({ engine: "topic_to_video" }))).toBeNull();
  });

  it("counts a slideshow's crossfade overlap but not a cut", () => {
    const scenes = [4, 4, 4].map((durationSec, i) => ({
      id: `s${i}`,
      text: "",
      visual: "",
      durationSec,
      previewPath: null,
      outfitId: null,
    }));
    expect(clipStoryboardTotalSec(board({ visualsSource: "slide", scenes }))).toBe(11);
    expect(clipStoryboardTotalSec(board({ visualsSource: "prompt", scenes }))).toBe(12);
  });
});

describe("planClipStoryboard for the user's own photos", () => {
  it("plans a slideshow from the uploaded photos without generating anything", async () => {
    const job = makeJob({
      engine: "slideshow",
      sourceImagePaths: ["/objects/1/u/a.png", "/objects/1/u/b.png"],
      options: { aspectRatio: "9:16", slideDurationSec: 4 },
    });
    const result = await plan(job, "slide");
    expect(result.visualsSource).toBe("slide");
    expect(result.timelineLocked).toBe(false);
    expect(result.narration).toBeNull();
    expect(result.durationBounds).toEqual({ minSec: 1, maxSec: 10 });
    // The previews ARE the uploads, so planning costs nothing and there is
    // nothing generated that could be redrawn.
    expect(result.scenes.map((s) => s.previewPath)).toEqual([
      "/objects/1/u/a.png",
      "/objects/1/u/b.png",
    ]);
    expect(result.scenes.map((s) => s.visual)).toEqual(["", ""]);
    expect(result.scenes.map((s) => s.durationSec)).toEqual([4, 4]);
    expect(state.keyframePrompts).toEqual([]);
  });

  it("caps a slideshow plan at what the encoder accepts", async () => {
    const job = makeJob({
      engine: "slideshow",
      sourceImagePaths: Array.from({ length: 25 }, (_, i) => `/objects/1/u/${i}.png`),
      options: { aspectRatio: "9:16", slideDurationSec: 3 },
    });
    expect((await plan(job, "slide")).scenes).toHaveLength(20);
  });

  it("plans one animated scene from the first photo, clamped to what a clip can be", async () => {
    const job = makeJob({
      engine: "image_to_video",
      prompt: "  Slow push in on the cup  ",
      sourceImagePaths: ["/objects/1/u/cup.png", "/objects/1/u/ignored.png"],
      options: { aspectRatio: "9:16", durationSec: 30 },
    });
    const result = await plan(job, "photo");
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.visual).toBe("Slow push in on the cup");
    expect(result.scenes[0]!.previewPath).toBe("/objects/1/u/cup.png");
    expect(result.scenes[0]!.durationSec).toBe(10);
  });

  it("refuses to plan a photo job with no photo", async () => {
    await expect(plan(makeJob({ engine: "slideshow", sourceImagePaths: [] }), "slide")).rejects.toThrow(
      /No photos provided/,
    );
    await expect(
      plan(makeJob({ engine: "image_to_video", sourceImagePaths: null }), "photo"),
    ).rejects.toThrow(/No source image provided/);
  });
});

describe("planClipStoryboard for text-to-video", () => {
  it("keeps a single shot as the brief itself, with no still to show", async () => {
    const result = await plan(makeJob({ options: { aspectRatio: "9:16" } }), "prompt");
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.visual).toBe("A barista pulling an espresso shot");
    // A prompt plan is a shot list; there is deliberately no image generated.
    expect(result.scenes[0]!.previewPath).toBeNull();
    expect(result.scenes[0]!.durationSec).toBe(5);
    expect(state.splitPrompt).toBe("");
  });

  it("splits a multi-shot brief and asks for wardrobe and location to carry across", async () => {
    state.shotReply = JSON.stringify({ shots: ["Grinding beans", "Tamping", "The pour"] });
    const result = await plan(
      makeJob({ options: { aspectRatio: "9:16", shotCount: 3, durationSec: 6 } }),
      "prompt",
    );
    expect(result.scenes.map((s) => s.visual)).toEqual(["Grinding beans", "Tamping", "The pour"]);
    expect(result.scenes.map((s) => s.durationSec)).toEqual([6, 6, 6]);
    expect(state.splitPrompt).toContain("exactly 3 consecutive shots");
    expect(state.splitPrompt).toContain("same subject, wardrobe, location and visual style");
  });

  it("always returns exactly the shot count the job was funded for", async () => {
    // Short reply: padded from the brief. Long reply: truncated. Either way the
    // plan matches what was reserved, so billing and delivery cannot diverge.
    state.shotReply = JSON.stringify({ shots: ["Only one"] });
    const short = await plan(makeJob({ options: { aspectRatio: "9:16", shotCount: 3 } }), "prompt");
    expect(short.scenes.map((s) => s.visual)).toEqual([
      "Only one",
      "A barista pulling an espresso shot",
      "A barista pulling an espresso shot",
    ]);

    state.shotReply = JSON.stringify({ shots: ["a", "b", "c", "d", "e"] });
    const long = await plan(makeJob({ options: { aspectRatio: "9:16", shotCount: 2 } }), "prompt");
    expect(long.scenes.map((s) => s.visual)).toEqual(["a", "b"]);
  });

  it("falls back to the brief per shot rather than losing a funded job to a copy call", async () => {
    state.splitThrows = true;
    const thrown = await plan(makeJob({ options: { aspectRatio: "9:16", shotCount: 2 } }), "prompt");
    expect(thrown.scenes.map((s) => s.visual)).toEqual([
      "A barista pulling an espresso shot",
      "A barista pulling an espresso shot",
    ]);

    state.splitThrows = false;
    state.shotReply = JSON.stringify({ shots: "not an array" });
    const malformed = await plan(makeJob({ options: { aspectRatio: "9:16", shotCount: 2 } }), "prompt");
    expect(malformed.scenes.map((s) => s.visual)).toEqual([
      "A barista pulling an espresso shot",
      "A barista pulling an espresso shot",
    ]);
  });

  it("runs the split under a governed video_script template when one is active", async () => {
    pk.governedByFlow.video_script = "GOVERNED SCRIPT VOICE. Strict JSON only.";
    state.shotReply = JSON.stringify({ shots: ["one", "two"] });
    await plan(makeJob({ options: { aspectRatio: "9:16", shotCount: 2 } }), "prompt");
    expect(pk.getCalls).toEqual(["video_script"]);
    expect(state.systemPrompt).toBe("GOVERNED SCRIPT VOICE. Strict JSON only.");
    expect(pk.logged).toEqual(["video_script"]);
  });

  it("keeps the built-in split prompt when no template is active, without logging", async () => {
    state.shotReply = JSON.stringify({ shots: ["one", "two"] });
    await plan(makeJob({ options: { aspectRatio: "9:16", shotCount: 2 } }), "prompt");
    expect(state.systemPrompt).toContain("shot planner");
    expect(pk.logged).toEqual([]);
  });

  it("refuses to plan a clip job with no brief", async () => {
    await expect(plan(makeJob({ prompt: "   " }), "prompt")).rejects.toThrow(/A prompt is required/);
  });
});

describe("planClipStoryboard for a locked character", () => {
  const job = () =>
    makeJob({ options: { aspectRatio: "9:16", characterId: 7, outfitId: 3, shotCount: 3 } });

  it("draws every shot from one shared outfit reference so the person stays the same", async () => {
    state.shotReply = JSON.stringify({ shots: ["Walking out", "At the counter", "Sitting down"] });
    const result = await plan(job(), "character");
    expect(result.visualsSource).toBe("character");
    expect(state.keyframePrompts).toEqual(["Walking out", "At the counter", "Sitting down"]);
    // Same reference image behind all three — character and wardrobe uniformity
    // is the default, not something the user has to ask for.
    expect(new Set(state.keyframeRefs)).toEqual(new Set(["/objects/1/c/mira-red.png"]));
    expect(result.scenes.map((s) => s.outfitId)).toEqual([3, 3, 3]);
    expect(result.scenes.map((s) => s.previewPath)).toEqual([
      "/objects/1/sb/frame:Walking out.png",
      "/objects/1/sb/frame:At the counter.png",
      "/objects/1/sb/frame:Sitting down.png",
    ]);
  });

  it("leaves one failed still blank instead of losing the whole plan", async () => {
    state.shotReply = JSON.stringify({ shots: ["Walking out", "At the counter", "Sitting down"] });
    state.keyframeFailsOn = "At the counter";
    const result = await plan(job(), "character");
    expect(result.scenes.map((s) => s.previewPath)).toEqual([
      "/objects/1/sb/frame:Walking out.png",
      null,
      "/objects/1/sb/frame:Sitting down.png",
    ]);
  });
});

describe("renderClipStoryboard", () => {
  const render = (storyboard: VideoStoryboard, music?: Buffer) =>
    renderClipStoryboard({
      job: makeJob({}),
      storyboard,
      aspectRatio: "9:16",
      music: music ?? null,
      load: async (path) => ({ buffer: Buffer.from(path), mimeType: "image/png" }),
    });

  const scene = (over: Partial<VideoStoryboard["scenes"][number]>) => ({
    id: "s1",
    text: "",
    visual: "shot",
    durationSec: 5,
    previewPath: null,
    outfitId: null,
    ...over,
  });

  it("passes each slide its own length and caption through to the encoder", async () => {
    const result = await render(
      board({
        visualsSource: "slide",
        durationBounds: { minSec: 1, maxSec: 10 },
        scenes: [
          scene({ id: "s1", visual: "Day one", durationSec: 4, previewPath: "/objects/1/u/a.png" }),
          scene({ id: "s2", visual: "", durationSec: 2, previewPath: "/objects/1/u/b.png" }),
        ],
      }),
    );
    expect(state.slideshowCall).toEqual({
      imageCount: 2,
      slideDurationsSec: [4, 2],
      // An empty caption is a real value here: that slide shows no text.
      slideCaptions: ["Day one", ""],
    });
    expect(result.totalSec).toBe(5.5);
  });

  it("refuses a slideshow whose photo has gone missing", async () => {
    await expect(
      render(board({ visualsSource: "slide", scenes: [scene({ previewPath: null })] })),
    ).rejects.toThrow(/photo in this storyboard is missing/);
  });

  it("generates one clip per shot and joins them", async () => {
    const result = await render(
      board({
        visualsSource: "prompt",
        scenes: [
          scene({ id: "s1", visual: "Grinding beans", durationSec: 4 }),
          scene({ id: "s2", visual: "The pour", durationSec: 7 }),
        ],
      }),
      Buffer.from("music"),
    );
    expect(state.generateCalls).toEqual([
      { mode: "text", prompt: "Grinding beans", durationSec: 4, hasImage: false },
      { mode: "text", prompt: "The pour", durationSec: 7, hasImage: false },
    ]);
    expect(state.concatCount).toBe(2);
    expect(state.musicMixed).toBe(true);
    expect(result.totalSec).toBe(11);
    expect(result.provider).toBe("replicate");
  });

  it("animates the approved keyframe rather than re-drawing one", async () => {
    await render(
      board({
        visualsSource: "character",
        scenes: [scene({ visual: "Walking out", previewPath: "/objects/1/sb/one.png" })],
      }),
    );
    expect(state.generateCalls).toEqual([
      {
        mode: "image",
        prompt: "Walking out. Subtle natural motion, cinematic.",
        durationSec: 5,
        hasImage: true,
      },
    ]);
  });

  it("fails a character render whose approved keyframe is gone, rather than substituting one", async () => {
    await expect(
      render(board({ visualsSource: "character", scenes: [scene({ previewPath: null })] })),
    ).rejects.toThrow(/no longer available/);
  });

  it("re-clamps a stored length that is outside what the providers accept", async () => {
    await render(
      board({
        visualsSource: "prompt",
        durationBounds: { minSec: 3, maxSec: 10 },
        scenes: [scene({ durationSec: 45 })],
      }),
    );
    expect(state.generateCalls[0]!.durationSec).toBe(10);
  });

  it("refuses an empty storyboard", async () => {
    await expect(render(board({ visualsSource: "prompt", scenes: [] }))).rejects.toThrow(
      /no scenes/,
    );
  });
});

describe("post-approval shot prompt polish (video_scene_image)", () => {
  const render = (storyboard: VideoStoryboard) =>
    renderClipStoryboard({
      job: makeJob({}),
      storyboard,
      aspectRatio: "9:16",
      music: null,
      load: async (path) => ({ buffer: Buffer.from(path), mimeType: "image/png" }),
    });

  const scene = (id: string, visual: string) => ({
    id,
    text: "",
    visual,
    durationSec: 5,
    previewPath: null,
    outfitId: null,
  });

  it("polishes approved prompt shots under the governed template and persists them", async () => {
    pk.governedByFlow.video_scene_image = "GOVERNED ART DIRECTOR. Strict JSON only.";
    state.shotReply = JSON.stringify({
      prompts: ["Polished grinding, macro lens", "Polished pour, golden light"],
    });
    const storyboard = board({
      visualsSource: "prompt",
      scenes: [scene("s1", "Grinding beans"), scene("s2", "The pour")],
    });
    expect(await polishStoryboardPrompts(1, storyboard)).toBe(true);
    expect(pk.getCalls).toEqual(["video_scene_image"]);
    expect(state.systemPrompt).toBe("GOVERNED ART DIRECTOR. Strict JSON only.");
    expect(pk.logged).toEqual(["video_scene_image"]);
    // The approved texts are untouched; the polish lands in renderVisual.
    expect(storyboard.scenes.map((s) => s.visual)).toEqual(["Grinding beans", "The pour"]);
    expect(storyboard.scenes.map((s) => s.renderVisual)).toEqual([
      "Polished grinding, macro lens",
      "Polished pour, golden light",
    ]);
    // And the render uses the persisted polish.
    await render(storyboard);
    expect(state.generateCalls.map((c) => c.prompt)).toEqual([
      "Polished grinding, macro lens",
      "Polished pour, golden light",
    ]);
  });

  it("is written once: a retry with persisted prompts never re-polishes", async () => {
    const storyboard = board({
      visualsSource: "prompt",
      scenes: [{ ...scene("s1", "Grinding beans"), renderVisual: "Persisted polish" }],
    });
    expect(await polishStoryboardPrompts(1, storyboard)).toBe(false);
    expect(state.llmCalls).toBe(0);
    await render(storyboard);
    expect(state.generateCalls.map((c) => c.prompt)).toEqual(["Persisted polish"]);
  });

  it("falls back to the approved texts when the polish call fails", async () => {
    // The user approved these exact texts; a copywriting hiccup must not lose
    // the job or swap in anything they did not sign off.
    state.splitThrows = true;
    const storyboard = board({
      visualsSource: "prompt",
      scenes: [scene("s1", "Grinding beans")],
    });
    expect(await polishStoryboardPrompts(1, storyboard)).toBe(true);
    expect(storyboard.scenes[0]!.renderVisual).toBe("Grinding beans");
    await render(storyboard);
    expect(state.generateCalls.map((c) => c.prompt)).toEqual(["Grinding beans"]);
  });

  it("falls back per shot when the polish reply is short or blank", async () => {
    state.shotReply = JSON.stringify({ prompts: ["Polished one", ""] });
    const storyboard = board({
      visualsSource: "prompt",
      scenes: [scene("s1", "one"), scene("s2", "two")],
    });
    await polishStoryboardPrompts(1, storyboard);
    expect(storyboard.scenes.map((s) => s.renderVisual)).toEqual(["Polished one", "two"]);
  });

  it("never rewrites character shots after approval — the keyframe is the contract", async () => {
    const storyboard = board({
      visualsSource: "character",
      scenes: [{ ...scene("s1", "Walking out"), previewPath: "/objects/1/sb/one.png" }],
    });
    expect(await polishStoryboardPrompts(1, storyboard)).toBe(false);
    await render(storyboard);
    expect(state.llmCalls).toBe(0);
    expect(pk.getCalls).toEqual([]);
    expect(state.generateCalls[0]!.prompt).toBe("Walking out. Subtle natural motion, cinematic.");
  });
});

describe("videoJobUnits for multi-shot clips", () => {
  it("prices a text_to_video job at one unit per funded shot", () => {
    const base = { aspectRatio: "9:16" as const };
    expect(videoJobUnits("text_to_video", { ...base })).toBe(1);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 1 })).toBe(1);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 3 })).toBe(3);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 5 })).toBe(5);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 10 })).toBe(10);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 99 })).toBe(10);
    // Shot count is a text_to_video concept; nothing else prices off it.
    expect(videoJobUnits("image_to_video", { ...base, shotCount: 4 })).toBe(1);
    expect(videoJobUnits("slideshow", { ...base, shotCount: 4 })).toBe(1);
    // And an AI music bed still stacks on top.
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 3, musicPrompt: "lofi" })).toBe(4);
  });
});
