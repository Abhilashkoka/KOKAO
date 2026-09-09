import { describe, expect, it } from "vitest";
import { guidedSceneVisualPrompt, stripStoryboardDump } from "./guidedScenePrompt";
import { VideoGenProviderError } from "./types";

/**
 * These cases come from job #69001, which rendered the mother as two different
 * women across three scenes and returned one character in a shot that asked
 * for three. Each test pins one reason that was possible.
 */

const cast = [
  {
    roleId: "meera",
    character: { name: "Meera", referenceImagePath: "/objects/4/uploads/52f59f54" },
    outfit: {
      description: "a turquoise floral anarkali with an orange dupatta",
      referenceImagePath: "/objects/4/uploads/52f59f54",
    },
  },
  {
    roleId: "ma",
    character: { name: "Ma", referenceImagePath: "/objects/4/uploads/6a04c1d7" },
    outfit: {
      description: "a cream cotton sari",
      referenceImagePath: "/objects/4/uploads/6a04c1d7",
    },
  },
] as any;

const base = {
  scriptScene: { visualDirection: "A warm two-shot in the living room." },
  sceneCast: cast,
  backdrop: null,
  backdropLabel: "shared" as const,
  location: { mode: "text", imagePath: null, description: "A sunlit living room" },
  logoPath: null,
  platform: { aspectRatio: "9:16", safeArea: "Keep faces in the safe area." },
} as any;

describe("guidedSceneVisualPrompt", () => {
  it("never writes an app storage path into the prompt", () => {
    const prompt = guidedSceneVisualPrompt(base);
    // The exact bug from #69001: these paths reached Seedance as prose, so the
    // identity direction did nothing while looking like it worked.
    expect(prompt).not.toContain("/objects/");
    expect(prompt).not.toContain("identity reference");
    expect(prompt).not.toContain("outfit reference");
  });

  it("keeps the wardrobe, which is the part a model can act on", () => {
    const prompt = guidedSceneVisualPrompt(base);
    expect(prompt).toContain("a turquoise floral anarkali with an orange dupatta");
    expect(prompt).toContain("a cream cotton sari");
  });

  it("closes the cast so characters cannot quietly leave the frame", () => {
    const prompt = guidedSceneVisualPrompt(base);
    expect(prompt).toContain("Exactly 2 people are in frame: Meera and Ma");
    expect(prompt).toContain("no one enters and no one leaves");
  });

  it("ends on what must not change", () => {
    expect(guidedSceneVisualPrompt(base)).toContain(
      "stays identical to the references for the entire shot",
    );
  });

  it("names each character to its reference only when references are attached", () => {
    expect(guidedSceneVisualPrompt(base)).not.toContain("@Image");
    const labelled = guidedSceneVisualPrompt({
      ...base,
      referenceLabels: ["@Image1", "@Image2", "@Image3", "@Image4"],
    });
    expect(labelled).toContain("Meera's approved character sheet is @Image1");
    expect(labelled).toContain("approved outfit reference is @Image2");
    expect(labelled).toContain("Ma's approved character sheet is @Image3");
    expect(labelled).toContain("approved outfit reference is @Image4");
  });

  it("refuses a scene whose character has no approved outfit", () => {
    const noOutfit = {
      ...base,
      sceneCast: [{ roleId: "ma", character: { name: "Ma" }, outfit: null }] as any,
    };
    // "MISSING" used to be written into the prompt as a literal word.
    expect(() => guidedSceneVisualPrompt(noOutfit)).toThrow(VideoGenProviderError);
    expect(() => guidedSceneVisualPrompt(noOutfit)).toThrow(/no approved outfit/i);
  });

  it("strips the storyboard dump out of the backdrop direction", () => {
    const prompt = guidedSceneVisualPrompt({
      ...base,
      backdrop: {
        imagePath: "/objects/4/uploads/8c1f8d23",
        prompt:
          "Create the primary shared location for the Guided Story. " +
          "Scene 1: Centered 9:16 living-room group shot. " +
          "Scene 2: Same shared frame, slightly tighter. " +
          "Scene 3: Shared reaction shot. She....",
      },
      backdropLabel: "default",
    });
    expect(prompt).toContain("the approved default backdrop");
    expect(prompt).toContain("Create the primary shared location");
    // Every scene prompt used to carry all three shots.
    expect(prompt).not.toContain("Scene 1:");
    expect(prompt).not.toContain("Scene 3:");
    expect(prompt).not.toContain("She....");
    expect(prompt).not.toContain("/objects/");
  });

  it("asks for logo space rather than naming a file it cannot open", () => {
    const prompt = guidedSceneVisualPrompt({
      ...base,
      logoPath: "/objects/4/uploads/logo.png",
    });
    expect(prompt).toContain("clear space in the lower third");
    expect(prompt).not.toContain("/objects/");
  });

  it("keeps the platform framing line last", () => {
    expect(guidedSceneVisualPrompt(base).trimEnd().endsWith("Keep faces in the safe area.")).toBe(
      true,
    );
  });
});

describe("stripStoryboardDump", () => {
  it("cuts everything from the first scene heading onwards", () => {
    expect(stripStoryboardDump("A sunlit room. Scene 1: wide shot. Scene 2: tighter.")).toBe(
      "A sunlit room.",
    );
  });

  it("drops a truncated trailing fragment", () => {
    expect(stripStoryboardDump("A sunlit room.\nShe reaches for the file and....")).toBe(
      "A sunlit room.",
    );
  });

  it("leaves clean direction untouched", () => {
    expect(stripStoryboardDump("A sunlit living room with plants.")).toBe(
      "A sunlit living room with plants.",
    );
  });
});