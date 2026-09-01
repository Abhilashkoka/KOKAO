import { describe, it, expect } from "vitest";
import { defaultShotSize, normalizeShotSize, SHOT_SIZES } from "./characterScenes";
import { sceneKeyframePrompt } from "../../characters";
import type { Character, CharacterOutfit } from "@workspace/db";

const CHARACTER = { id: 1, name: "Asha", description: "a paediatrician" } as Character;
const OUTFIT = { id: 7, name: "Scrubs", description: "teal scrubs" } as CharacterOutfit;

describe("defaultShotSize", () => {
  it("never offers a wide shot to a scene that speaks", () => {
    // The sync model crops around the face. A wide frame starves that crop
    // before it starts — the same face-pixel rule the upload path enforces,
    // arriving here as a composition constraint.
    for (let i = 0; i < 12; i++) {
      expect(defaultShotSize(i, true)).not.toBe("wide");
    }
  });

  it("alternates rather than repeating one size", () => {
    const speaking = Array.from({ length: 8 }, (_, i) => defaultShotSize(i, true));
    expect(new Set(speaking).size).toBeGreaterThan(1);
    for (let i = 2; i < speaking.length; i++) {
      // Never three of the same in a row, which is the defect this replaces.
      expect(speaking[i] === speaking[i - 1] && speaking[i - 1] === speaking[i - 2]).toBe(false);
    }
  });

  it("opens wide when nobody has to be synced", () => {
    expect(defaultShotSize(0, false)).toBe("wide");
    expect(new Set(Array.from({ length: 8 }, (_, i) => defaultShotSize(i, false))).size)
      .toBeGreaterThan(2);
  });
});

describe("normalizeShotSize", () => {
  it("keeps a reviewed size", () => {
    for (const size of SHOT_SIZES) {
      if (size === "wide") continue;
      expect(normalizeShotSize(size, 0, true)).toBe(size);
    }
    expect(normalizeShotSize("wide", 0, false)).toBe("wide");
  });

  it("rescues a board approved before lip sync was switched on", () => {
    // A stored wide is legitimate; it just cannot survive into a synced job.
    expect(normalizeShotSize("wide", 0, true)).toBe("medium");
  });

  it("falls back to the rotation, not to one repeated size", () => {
    for (const junk of [undefined, null, "", "extreme-closeup", 3, {}]) {
      expect(SHOT_SIZES).toContain(normalizeShotSize(junk, 0, true));
    }
    const recovered = Array.from({ length: 6 }, (_, i) => normalizeShotSize(null, i, true));
    expect(new Set(recovered).size).toBeGreaterThan(1);
  });
});

describe("sceneKeyframePrompt framing", () => {
  it("names the shot in camera terms rather than leaving it to chance", () => {
    const close = sceneKeyframePrompt(CHARACTER, OUTFIT, "waiting in a corridor", "close");
    const wide = sceneKeyframePrompt(CHARACTER, OUTFIT, "waiting in a corridor", "wide");
    expect(close).toMatch(/Close-up/);
    expect(close).toMatch(/face occupying much of the frame/i);
    expect(wide).toMatch(/Wide shot/);
    expect(wide).toMatch(/full-length/i);
    expect(close).not.toBe(wide);
  });

  it("still carries identity and wardrobe unchanged", () => {
    // Framing is additive. The outfit lock is what keeps a character the same
    // character, and it must survive the new language intact.
    const prompt = sceneKeyframePrompt(CHARACTER, OUTFIT, "waiting in a corridor", "medium");
    expect(prompt).toMatch(/reference image is authoritative/i);
    expect(prompt).toContain(OUTFIT.description);
    expect(prompt).toMatch(/identical face, hair, body, identity/i);
    expect(prompt).toMatch(/No text, no watermark/);
  });

  it("defaults to a medium shot when no size is given", () => {
    expect(sceneKeyframePrompt(CHARACTER, OUTFIT, "a corridor")).toMatch(/Medium shot/);
  });
});
