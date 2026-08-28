import { describe, expect, it } from "vitest";
import type { Character, CharacterOutfit } from "@workspace/db";
import { sceneKeyframePrompt } from "./characters";

describe("sceneKeyframePrompt", () => {
  it("makes the selected outfit reference authoritative over conflicting scene prose", () => {
    const prompt = sceneKeyframePrompt(
      { name: "Maya", description: "founder" } as Character,
      {
        name: "Blue blazer",
        description: "navy blue blazer, white shirt, black trousers",
      } as CharacterOutfit,
      "Maya finishes a workout in implied gym clothes",
    );

    expect(prompt).toContain("reference image is authoritative for both identity and clothing");
    expect(prompt).toContain(
      "Required outfit: Blue blazer — navy blue blazer, white shirt, black trousers",
    );
    expect(prompt).toContain("ignore any conflicting wardrobe implied by it");
    expect(prompt).toContain("Do not redesign, substitute, infer, or add clothing");
  });
});