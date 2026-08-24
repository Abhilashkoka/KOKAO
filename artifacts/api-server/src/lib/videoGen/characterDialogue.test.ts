import { describe, expect, it } from "vitest";
import {
  ELEVEN_V3_LOCALES,
  characterDialogueLocale,
  planCharacterDialogueScenes,
} from "./characterDialogue";
import { videoJobUnits } from "./units";

describe("character dialogue catalog and planner", () => {
  it("ships the server-owned verified 74-language Eleven v3 catalog", () => {
    expect(ELEVEN_V3_LOCALES).toHaveLength(74);
    expect(characterDialogueLocale("te")).toMatchObject({
      bcp47: "te-IN", modelId: "eleven_v3", script: "Telugu",
    });
    expect(characterDialogueLocale("ur")).toMatchObject({ direction: "rtl" });
    expect(characterDialogueLocale("not-a-locale")).toBeNull();
  });

  it("preserves Telugu exact bytes and prefers a sentence boundary", () => {
    const input = `${"తెలుగు మాటలు ".repeat(12)}. ${"తదుపరి వాక్యం ".repeat(30)}`;
    const scenes = planCharacterDialogueScenes(input, "presenter at a desk", characterDialogueLocale("te")!);
    expect(scenes.map((scene) => scene.text).join("")).toBe(input);
    expect(scenes[0]!.text).toMatch(/\.\s$/u);
    expect(scenes.every((scene) => scene.estimatedDurationSec <= 30)).toBe(true);
  });

  it("splits scripts without Latin spaces without changing order", () => {
    const input = "这是一个没有空格的脚本。".repeat(40);
    const scenes = planCharacterDialogueScenes(input, "portrait", characterDialogueLocale("zh")!);
    expect(scenes.length).toBeGreaterThan(1);
    expect(scenes.map((scene) => scene.text).join("")).toBe(input);
  });

  it.each([
    ["zh", "这是中文句子。".repeat(30)],
    ["ja", "これは日本語の文です。".repeat(30)],
    ["th", "นี่คือประโยคภาษาไทย".repeat(30)],
    ["ur", "یہ ایک دائیں سے بائیں جملہ ہے۔ ".repeat(40)],
  ])("preserves %s exact order with safe <=30s scenes", (code, input) => {
    const scenes = planCharacterDialogueScenes(input, "portrait", characterDialogueLocale(code)!);
    expect(scenes.map((scene) => scene.text).join("")).toBe(input);
    expect(scenes.every((scene) => scene.estimatedDurationSec <= 30)).toBe(true);
  });

  it("splits oversized words on grapheme boundaries without splitting emoji or combining marks", () => {
    const grapheme = "👩🏽‍💻e\u0301";
    const input = grapheme.repeat(100);
    const scenes = planCharacterDialogueScenes(input, "portrait", characterDialogueLocale("en")!);
    expect(scenes.map((scene) => scene.text).join("")).toBe(input);
    expect(scenes.every((scene) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(scene.text)].length <= 80)).toBe(true);
  });

  it("splits whitespace scripts at no more than 32 words while retaining edge whitespace", () => {
    const input = ` \n${Array.from({ length: 65 }, (_, index) => `word${index}`).join(" ")} \n`;
    const scenes = planCharacterDialogueScenes(input, "portrait", characterDialogueLocale("en")!);
    expect(scenes.map((scene) => scene.text).join("")).toBe(input);
    expect(scenes).toHaveLength(3);
    expect(scenes.every((scene) => scene.estimatedDurationSec <= 30)).toBe(true);
  });

  it("prices two operations per frozen scene", () => {
    expect(videoJobUnits("dialogue_lip_sync", {
      aspectRatio: "9:16",
      characterDialogue: {
        version: 1, scriptApproved: true, locale: "te", modelId: "eleven_v3", direction: "ltr",
        script: "Telugu", scriptName: "Telugu", fontCandidates: ["Noto Sans Telugu"],
        characterId: 1, outfitId: 2, brandKitId: 3,
        scenes: [{ id: "a", text: "one", visualPrompt: "p", estimatedDurationSec: 3 },
          { id: "b", text: "two", visualPrompt: "p", estimatedDurationSec: 3 }],
      },
    })).toBe(4);
  });
});