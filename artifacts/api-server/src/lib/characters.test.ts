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
    await generateSceneKeyframe(CHARACTER, OUTFIT, "a corridor", "9:16", REFERENCE);

    expect(generateImage).toHaveBeenCalledTimes(1);
    const [, , reference, opts] = generateImage.mock.calls[0]!;
    expect(reference).toBe(REFERENCE);
    expect(opts?.requireReferenceInput).toBe(true);
  });

  it("requires it for costume variants too", async () => {
    await generateOutfitVariant(CHARACTER, "a white coat", REFERENCE);

    const [, , reference, opts] = generateImage.mock.calls[0]!;
    expect(reference).toBe(REFERENCE);
    expect(opts?.requireReferenceInput).toBe(true);
  });

  it("keeps masked-edit routing intact when it applies", async () => {
    const exactMaskedEdit = { protectedRectangle: { x: 0, y: 0, width: 1, height: 0.4 } };
    const onProviderSuccess = vi.fn(async () => {});
    await generateOutfitVariant(
      CHARACTER,
      "a white coat",
      REFERENCE,
      exactMaskedEdit as never,
      onProviderSuccess,
    );

    const opts = generateImage.mock.calls[0]![3]!;
    expect(opts.requireReferenceInput).toBe(true);
    expect(opts.exactMaskedEdit).toBe(exactMaskedEdit);
    expect(opts.onProviderSuccess).toBe(onProviderSuccess);
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