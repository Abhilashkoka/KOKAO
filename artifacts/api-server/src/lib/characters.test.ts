import { describe, expect, it } from "vitest";
import type { Character, CharacterOutfit } from "@workspace/db";
import sharp from "sharp";
import { createOutfitMaskedEdit, sceneKeyframePrompt } from "./characters";

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

describe("createOutfitMaskedEdit", () => {
  it("opens only the clothing area below the protected face-and-hair region", async () => {
    const image = await sharp({
      create: {
        width: 100,
        height: 150,
        channels: 4,
        background: { r: 20, g: 30, b: 40, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const edit = await createOutfitMaskedEdit(
      { buffer: image, mimeType: "image/png" },
      { x: 0.2, y: 0.05, width: 0.6, height: 0.35 },
    );
    const raw = await sharp(edit.mask.buffer).ensureAlpha().raw().toBuffer();
    const alphaAt = (x: number, y: number) => raw[(y * 100 + x) * 4 + 3];

    expect(alphaAt(50, 30)).toBe(255);
    expect(alphaAt(50, 100)).toBe(0);
    expect(alphaAt(1, 100)).toBe(255);
  });
});