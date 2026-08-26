import { describe, expect, it } from "vitest";
import type { ResolvedCreativeBrief, VideoStoryboard } from "@workspace/db";
import {
  appendCreativeFragment,
  compileCreativeBrief,
  lintStoryboardCreativeBrief,
} from "./creativeBrief";

const brief: ResolvedCreativeBrief = {
  version: 1,
  topic: "A solar charger",
  direction: {
    version: 1,
    narrative: {
      tone: "warm",
      requiredVocabulary: ["solar"],
      forbiddenVocabulary: ["guaranteed"],
      evidenceRules: [{ kind: "data", instruction: "Mark unsupported numbers for review" }],
    },
    structure: {
      beats: [{ purpose: "hook", instruction: "Open on the viewer's problem" }],
    },
    visual: {
      style: "documentary",
      lighting: "natural",
      stockQueryGuidance: "prefer practical everyday settings",
    },
    sonic: { mood: "optimistic", energy: 3, rhythm: "steady" },
    captions: { rhythm: "word_group", emphasis: "keywords" },
  },
  provenance: [{ source: "template", reference: "videoStyleProfile:7", fields: ["visual.style"] }],
  clamps: [],
};

function board(text: string): VideoStoryboard {
  return {
    version: 1,
    visualsSource: "ai",
    timelineLocked: true,
    model: null,
    provider: null,
    regenerations: 0,
    narration: null,
    scenes: [{
      id: "s1",
      text,
      visual: "A commuter places a solar charger beside a backpack",
      durationSec: 4,
      previewPath: null,
      outfitId: null,
    }],
  };
}

describe("compiled creative brief fragments", () => {
  it("keeps legacy jobs byte-for-byte unchanged when no snapshot exists", () => {
    expect(compileCreativeBrief(null)).toEqual({
      script: null,
      storyboard: null,
      visual: null,
      stock: null,
      captionStyle: null,
      music: null,
    });
    expect(appendCreativeFragment("The original subject", null)).toBe("The original subject");
  });

  it("compiles narrow script, visual, stock, caption and music fragments", () => {
    const fragments = compileCreativeBrief(brief);
    expect(fragments.script).toContain("Tone: warm");
    expect(fragments.storyboard).toContain("Preferred beat arc");
    expect(fragments.visual).toContain("preserve each scene's existing subject");
    expect(fragments.stock).toContain("preserve the scene subject");
    expect(fragments.captionStyle).toBe("dynamic");
    expect(fragments.music).toContain("mood optimistic");
  });

  it("appends treatment after the subject and is deterministic across retries", () => {
    const first = compileCreativeBrief(structuredClone(brief));
    const retry = compileCreativeBrief(structuredClone(brief));
    expect(retry).toEqual(first);
    const prompt = appendCreativeFragment("A solar charger on a desk", first.visual);
    expect(prompt.indexOf("A solar charger")).toBeLessThan(prompt.indexOf("Treatment only"));
  });

  it("lints required, forbidden and unverified review text", () => {
    expect(lintStoryboardCreativeBrief(board("A guaranteed result [VERIFY: 42%]"), brief))
      .toEqual(expect.arrayContaining([
        { kind: "required_vocabulary", term: "solar" },
        { kind: "forbidden_vocabulary", term: "guaranteed" },
        { kind: "unverified_claim", term: "[VERIFY]" },
      ]));
    expect(lintStoryboardCreativeBrief(board("A practical solar option"), brief)).toEqual([]);
  });

  it("keeps stripped verification markers as durable, non-spoken review findings", () => {
    const reviewed = {
      ...board("A practical solar option"),
      verificationFindings: ["[VERIFY: quoted savings figure]"],
    };
    expect(lintStoryboardCreativeBrief(reviewed, brief)).toContainEqual({
      kind: "unverified_claim",
      term: "[VERIFY]",
    });
    expect(reviewed.scenes[0]!.text).not.toContain("[VERIFY");
  });

  it("does not derive music from an explicit none mood", () => {
    expect(compileCreativeBrief({
      ...brief,
      direction: { ...brief.direction, sonic: { mood: "none", guidance: "no music" } },
    }).music).toBeNull();
  });
});