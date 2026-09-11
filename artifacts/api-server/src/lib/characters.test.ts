import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Character, CharacterOutfit } from "@workspace/db";
import sharp from "sharp";

/**
 * Typed to generateImage's real shape, so the assertions below are checked
 * against the contract rather than against `any` — the point of these tests is
 * an argument that was previously not being passed at all.
 */
const generateImage = vi.fn(
  async (
    _prompt: string,
    _size: string,
    _reference?: { buffer: Buffer; mimeType: string },
    _opts?: {
      transparent?: boolean;
      exactMaskedEdit?: unknown;
      requireReferenceInput?: boolean;
      forceCapabilityFallback?: boolean;
      onProviderSuccess?: (meta: { provider: string; model: string }) => Promise<void>;
    },
  ) => ({
    buffer: Buffer.from("png"),
    mimeType: "image/png" as const,
    provider: "openai",
    model: "gpt-image-1",
    fallbackStep: 0,
    routingReason: "test",
  }),
);
vi.mock("./imageGen", () => ({ generateImage }));

const {
  createOutfitMaskedEdit,
  sceneKeyframePrompt,
  generateSceneKeyframe,
  generateOutfitVariant,
  generateCharacterReferenceSheet,
  characterReferenceSheetPrompt,
  isCharacterReferenceSheetApproved,
} = await import("./characters");

const CHARACTER = { name: "Maya", description: "founder" } as Character;
const OUTFIT = {
  name: "Blue blazer",
  description: "navy blue blazer, white shirt, black trousers",
} as CharacterOutfit;
const REFERENCE = { buffer: Buffer.from("ref"), mimeType: "image/png" as const };

describe("sceneKeyframePrompt", () => {
  it("makes the selected outfit reference authoritative over conflicting scene prose", () => {
    const prompt = sceneKeyframePrompt(
      CHARACTER,
      OUTFIT,
      "Maya finishes a workout in implied gym clothes",
    );

    expect(prompt).toContain("reference image is authoritative for identity and clothing only");
    expect(prompt).toContain(
      "Required outfit: Blue blazer — navy blue blazer, white shirt, black trousers",
    );
    expect(prompt).toContain("ignore any conflicting wardrobe implied by it");
    expect(prompt).toContain("Do not redesign, substitute, infer, or add clothing");
  });

  it("takes the background from the scene, never from the reference", () => {
    const prompt = sceneKeyframePrompt(CHARACTER, OUTFIT, "a busy hospital corridor", "medium");

    expect(prompt).toContain("Do not copy the reference's background, pose, camera angle, or framing");
    expect(prompt).toMatch(/no studio backdrop, seamless wall, or empty grey field/i);
    expect(prompt).toContain("a busy hospital corridor");
    expect(prompt).toMatch(/Pose and body language come from the scene action/i);
  });

  it("keeps identity and wardrobe locked while the setting is freed", () => {
    const prompt = sceneKeyframePrompt(CHARACTER, OUTFIT, "a busy hospital corridor", "close");

    expect(prompt).toMatch(/identical face, hair, body, identity, and exact referenced outfit/i);
    expect(prompt).toContain("Copy every visible garment, color, pattern, layer, accessory");
    expect(prompt).toContain("Close-up");
    expect(prompt).toContain("No text, no watermark");
  });
});

describe("reference-required routing", () => {
  beforeEach(() => generateImage.mockClear());

  it("refuses to render a scene keyframe without the reference reaching the provider", async () => {
    await generateSceneKeyframe(CHARACTER, OUTFIT, "a corridor", "9:16", REFERENCE, null, "medium");

    expect(generateImage).toHaveBeenCalledTimes(1);
    const [, , reference, opts] = generateImage.mock.calls[0]!;
    expect(reference).toBe(REFERENCE);
    expect(opts?.requireReferenceInput).toBe(true);
  });

  it("requires it for costume variants too", async () => {
    await generateOutfitVariant(CHARACTER, "a white coat", REFERENCE, null);

    const [, , reference, opts] = generateImage.mock.calls[0]!;
    expect(reference).toBe(REFERENCE);
    expect(opts?.requireReferenceInput).toBe(true);
  });

  it("uses either uploaded or AI primary portraits as required sheet input", async () => {
    await generateCharacterReferenceSheet(CHARACTER, REFERENCE, null);

    const [prompt, size, reference, opts] = generateImage.mock.calls[0]!;
    expect(size).toBe("1536x1024");
    expect(reference).toBe(REFERENCE);
    expect(opts?.requireReferenceInput).toBe(true);
    expect(opts?.forceCapabilityFallback).toBe(true);
    expect(prompt).toContain("full-body front view");
    expect(prompt).toContain("side/profile view");
    expect(prompt).toContain("full-body back view");
    expect(prompt).toContain("front close-up");
    expect(prompt).toContain("top-down view");
    expect(prompt).toMatch(/same person/i);
  });

  it("keeps masked-edit routing intact when it applies", async () => {
    const exactMaskedEdit = { protectedRectangle: { x: 0, y: 0, width: 1, height: 0.4 } };
    const onProviderSuccess = vi.fn(async () => {});
    await generateOutfitVariant(
      CHARACTER,
      "a white coat",
      REFERENCE,
      null,
      exactMaskedEdit as never,
      onProviderSuccess,
    );

    const opts = generateImage.mock.calls[0]![3]!;
    expect(opts.requireReferenceInput).toBe(true);
    expect(opts.exactMaskedEdit).toBe(exactMaskedEdit);
    expect(opts.onProviderSuccess).toBe(onProviderSuccess);
  });
});

describe("character reference sheet approval", () => {
  it("fails closed unless both a generated path and explicit approval exist", () => {
    expect(
      isCharacterReferenceSheetApproved({
        ...CHARACTER,
        referenceSheetStatus: "pending",
        referenceSheetImagePath: "/objects/1/sheet.png",
      } as Character),
    ).toBe(false);
    expect(
      isCharacterReferenceSheetApproved({
        ...CHARACTER,
        referenceSheetStatus: "approved",
        referenceSheetImagePath: null,
      } as Character),
    ).toBe(false);
    expect(
      isCharacterReferenceSheetApproved({
        ...CHARACTER,
        referenceSheetStatus: "approved",
        referenceSheetImagePath: "/objects/1/sheet.png",
      } as Character),
    ).toBe(true);
  });

  it("asks for one identity, exact clothing, and natural studio treatment", () => {
    const prompt = characterReferenceSheetPrompt(CHARACTER);
    expect(prompt).toMatch(/exact same single person/i);
    expect(prompt).toMatch(/exact identity/i);
    expect(prompt).toMatch(/clothing/i);
    expect(prompt).toMatch(/light gray/i);
    expect(prompt).toMatch(/photorealistic cinematic/i);
    expect(prompt).toMatch(/natural even lighting/i);
    expect(prompt).toMatch(/do not invent multiple distinct people/i);
  });

  it("bans every non-photographic element, because this image IS the model's reference", () => {
    const prompt = characterReferenceSheetPrompt(CHARACTER);
    // Job #69001's sheets carried panel headers, hex swatch chips, a "Detail
    // Swatch" caption, garbled labels, and a title naming the wrong character.
    // A reference model reads all of that as part of the subject.
    expect(prompt).toMatch(/no text/i);
    expect(prompt).toMatch(/no titles/i);
    expect(prompt).toMatch(/no names/i);
    expect(prompt).toMatch(/no panel labels/i);
    expect(prompt).toMatch(/no color swatches/i);
    // The old prompt asked for exactly what went wrong.
    expect(prompt).not.toMatch(/labeled grid/i);
    expect(prompt).not.toMatch(/include small useful detail and color swatches/i);
  });

  it("still asks the face close-up to fill its panel", () => {
    // Face pixels are the identity signal; in a five-panel grid they are
    // already scarce, so the close-up must not be framed as another wide shot.
    expect(characterReferenceSheetPrompt(CHARACTER)).toMatch(/filling its panel/i);
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