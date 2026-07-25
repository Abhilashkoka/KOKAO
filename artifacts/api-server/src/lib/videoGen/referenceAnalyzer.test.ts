import { describe, it, expect, afterAll, vi } from "vitest";
import {
  frameTimestamps,
  wordsPerMinute,
  parseStyleProfile,
  buildStyleGuidance,
  loadStyleGuidance,
  REFERENCE_FRAME_COUNT,
  type ReferenceMeasurements,
} from "./referenceAnalyzer";

// ffmpeg, ASR, and the vision call have their own coverage; this file pins the
// pure logic that decides what a style profile is allowed to say.
vi.mock("../textGen", () => ({ getTextGenClient: vi.fn() }));

const measured = (over: Partial<ReferenceMeasurements> = {}): ReferenceMeasurements => ({
  durationSec: 30,
  wordsPerMinute: 160,
  transcript: "Here is the thing nobody tells you about morning routines.",
  ...over,
});

describe("frameTimestamps", () => {
  it("samples slice midpoints so fades and end cards never dominate", () => {
    // 12s over 6 frames: midpoints of 2s slices -> 1, 3, 5, 7, 9, 11.
    expect(frameTimestamps(12, 6)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("never samples at 0 or at the very last frame", () => {
    const stamps = frameTimestamps(45.5, REFERENCE_FRAME_COUNT);
    expect(stamps).toHaveLength(REFERENCE_FRAME_COUNT);
    expect(stamps[0]).toBeGreaterThan(0);
    expect(stamps.at(-1)!).toBeLessThan(45.5);
    // Chronological order is what the prompt promises the model.
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("degrades to a single frame for empty or nonsense durations", () => {
    expect(frameTimestamps(0, 6)).toEqual([0]);
    expect(frameTimestamps(-4, 6)).toEqual([0]);
    expect(frameTimestamps(Number.NaN, 6)).toEqual([0]);
  });

  it("asks for at least one frame however low the count", () => {
    expect(frameTimestamps(10, 0)).toHaveLength(1);
    expect(frameTimestamps(10, -3)).toHaveLength(1);
  });
});

describe("wordsPerMinute", () => {
  it("measures narration speed from the transcript and analyzed window", () => {
    // 8 words in 4s -> 120 wpm.
    expect(wordsPerMinute("one two three four five six seven eight", 4)).toBe(120);
  });

  it("returns 0 for silent references instead of a misleading number", () => {
    expect(wordsPerMinute("", 30)).toBe(0);
    expect(wordsPerMinute("   \n  ", 30)).toBe(0);
  });

  it("returns 0 rather than dividing by an unusable duration", () => {
    expect(wordsPerMinute("some words here", 0)).toBe(0);
    expect(wordsPerMinute("some words here", Number.NaN)).toBe(0);
  });
});

describe("parseStyleProfile", () => {
  const reply = {
    hookShape: "question straight to camera",
    sceneCount: 5,
    captionStyle: "karaoke",
    energy: "punchy",
    visualNotes: ["handheld framing", "warm grade", ""],
    scriptGuidance: "Short sentences. End on a question.",
  };

  it("keeps the measured numbers even when the model contradicts them", () => {
    const payload = parseStyleProfile(
      { ...reply, wordsPerMinute: 9999, sourceDurationSec: 600 },
      measured(),
    )!;
    expect(payload.pacing.wordsPerMinute).toBe(160);
    expect(payload.sourceDurationSec).toBe(30);
    // 30s over 5 scenes.
    expect(payload.pacing.avgSceneSec).toBe(6);
  });

  it("maps caption vocabulary onto the studio's three treatments", () => {
    const style = (captionStyle: unknown) =>
      parseStyleProfile({ ...reply, captionStyle }, measured())!.captionStyle;
    expect(style("karaoke")).toBe("dynamic");
    expect(style("word")).toBe("dynamic");
    expect(style("DYNAMIC")).toBe("dynamic");
    expect(style("none")).toBe("none");
    expect(style("off")).toBe("none");
    expect(style("full sentence subtitles")).toBe("classic");
    expect(style(undefined)).toBe("classic");
  });

  it("clamps the scene count and drops empty visual notes", () => {
    expect(parseStyleProfile({ ...reply, sceneCount: 900 }, measured())!.pacing.sceneCount).toBe(60);
    expect(parseStyleProfile({ ...reply, sceneCount: 0 }, measured())!.pacing.sceneCount).toBe(1);
    expect(parseStyleProfile({ ...reply, sceneCount: "many" }, measured())!.pacing.sceneCount).toBe(
      1,
    );
    expect(parseStyleProfile(reply, measured())!.visualNotes).toEqual([
      "handheld framing",
      "warm grade",
    ]);
  });

  it("caps the note list and the transcript excerpt", () => {
    const payload = parseStyleProfile(
      { ...reply, visualNotes: Array.from({ length: 20 }, (_, i) => `note ${i}`) },
      measured({ transcript: "x".repeat(2000) }),
    )!;
    expect(payload.visualNotes).toHaveLength(6);
    expect(payload.transcriptExcerpt).toHaveLength(400);
  });

  it("rejects a reply with neither a hook nor guidance", () => {
    expect(parseStyleProfile({ energy: "calm", sceneCount: 4 }, measured())).toBeNull();
    expect(parseStyleProfile({ hookShape: "  ", scriptGuidance: "" }, measured())).toBeNull();
    expect(parseStyleProfile(null, measured())).toBeNull();
    expect(parseStyleProfile("classic captions", measured())).toBeNull();
  });

  it("falls back to the hook when the model skips the guidance", () => {
    const payload = parseStyleProfile(
      { hookShape: "bold claim over a fast pan", sceneCount: 3 },
      measured(),
    )!;
    expect(payload.scriptGuidance).toBe("bold claim over a fast pan");
    expect(payload.version).toBe(1);
  });

  it("reports 0s scenes for a zero-length window instead of dividing by it", () => {
    const payload = parseStyleProfile(reply, measured({ durationSec: 0 }))!;
    expect(payload.pacing.avgSceneSec).toBe(0);
    expect(payload.sourceDurationSec).toBe(0);
  });
});

describe("buildStyleGuidance", () => {
  const payload = parseStyleProfile(
    {
      hookShape: "question straight to camera",
      sceneCount: 5,
      captionStyle: "dynamic",
      energy: "punchy",
      visualNotes: ["handheld framing"],
      scriptGuidance: "Short sentences. End on a question.",
    },
    measured(),
  )!;

  it("describes structure the script writer can act on", () => {
    const guidance = buildStyleGuidance(payload);
    expect(guidance).toContain("Open the same way: question straight to camera.");
    expect(guidance).toContain("Energy: punchy.");
    expect(guidance).toContain("160 words per minute");
    expect(guidance).toContain("cuts about every 6s");
    expect(guidance).toContain("Short sentences. End on a question.");
  });

  it("never leaks the reference's own words into the guidance", () => {
    expect(buildStyleGuidance(payload)).not.toContain(measured().transcript);
  });

  it("drops the narration pace for a silent reference", () => {
    const silent = { ...payload, pacing: { ...payload.pacing, wordsPerMinute: 0 } };
    expect(buildStyleGuidance(silent)).not.toContain("words per minute");
    expect(buildStyleGuidance(silent)).toContain("Open the same way");
  });
});

describe("loadStyleGuidance", () => {
  it("returns null without touching the database when no profile is requested", async () => {
    expect(await loadStyleGuidance(1, null)).toBeNull();
    expect(await loadStyleGuidance(1, undefined)).toBeNull();
    expect(await loadStyleGuidance(1, 0)).toBeNull();
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
