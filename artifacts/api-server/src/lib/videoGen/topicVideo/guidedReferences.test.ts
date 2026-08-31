import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  loadedPaths: [] as string[],
  generated: [] as Array<{
    prompt: string;
    referenceImage: { buffer: Buffer; mimeType: string };
    opts: { requireReferenceInput?: boolean } | undefined;
  }>,
  image: Buffer.alloc(0),
}));

vi.mock("../../characters", () => ({
  loadReferenceImage: vi.fn(async (path: string) => {
    state.loadedPaths.push(path);
    return { buffer: state.image, mimeType: "image/png" };
  }),
  characterDetailFromSnapshot: vi.fn(),
  getCharacterDetail: vi.fn(),
  resolveOutfit: vi.fn(),
}));

vi.mock("../../imageGen", () => ({
  generateImage: vi.fn(async (
    prompt: string,
    _size: string,
    referenceImage: { buffer: Buffer; mimeType: string },
    opts?: { requireReferenceInput?: boolean },
  ) => {
    state.generated.push({ prompt, referenceImage, opts });
    return {
      buffer: Buffer.from("generated"),
      provider: "openai",
      model: "gpt-image-1",
      fallbackStep: 0,
    };
  }),
}));

import { regenerateStoryboardPreview } from "./index";

beforeEach(async () => {
  state.loadedPaths.length = 0;
  state.generated.length = 0;
  state.image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#64748b" },
  }).png().toBuffer();
});

describe("Guided Story preview references", () => {
  it("loads the approved backdrop into a compact reference sheet and requires a reference-capable provider", async () => {
    const sha256 = createHash("sha256").update(state.image).digest("hex");
    const characterPath = "/objects/7/uploads/character.png";
    const outfitPath = "/objects/7/uploads/outfit.png";
    const backdropPath = "/objects/7/uploads/backdrop.png";

    await regenerateStoryboardPreview({
      tenantId: 7,
      storyboard: {} as never,
      scene: {
        id: "scene-1",
        visual: "The approved cast talks in the approved room.",
        guidedStory: {
          cast: [{
            roleId: "lead",
            characterName: "Lead",
            referenceImagePath: characterPath,
            outfitReferenceImagePath: outfitPath,
            characterReferenceSha256: sha256,
            outfitReferenceSha256: sha256,
          }],
          visuals: {
            logoPath: null,
            locationMode: "text",
            locationImagePath: null,
            locationDescription: "A room",
            backdropReferencePath: backdropPath,
            backdropReferenceFingerprint: "approved-fingerprint",
          },
        },
      } as never,
      aspectRatio: "16:9",
      upload: async () => "/objects/7/uploads/generated.png",
    });

    expect(state.loadedPaths).toEqual([characterPath, outfitPath, backdropPath]);
    expect(state.generated).toHaveLength(1);
    expect(state.generated[0]!.opts).toEqual({ requireReferenceInput: true });
    expect(state.generated[0]!.prompt).toContain("APPROVED SHARED BACKDROP");
    const metadata = await sharp(state.generated[0]!.referenceImage.buffer).metadata();
    expect(metadata.width).toBe(1536);
    expect(metadata.height).toBe(512);
  });

  it("binds a scene override by its approved bytes, not just its path", async () => {
    const sha256 = createHash("sha256").update(state.image).digest("hex");
    await regenerateStoryboardPreview({
      tenantId: 7,
      storyboard: {} as never,
      scene: {
        id: "scene-override",
        visual: "A different approved location.",
        guidedStory: {
          cast: [{
            roleId: "lead", characterName: "Lead",
            referenceImagePath: "/objects/7/uploads/character.png",
            outfitReferenceImagePath: "/objects/7/uploads/outfit.png",
            characterReferenceSha256: sha256, outfitReferenceSha256: sha256,
          }],
          visuals: {
            logoPath: null, locationMode: "none", locationImagePath: null,
            locationDescription: null,
            backdropReferencePath: "/objects/7/uploads/override.png",
            backdropReferenceFingerprint: "override-fingerprint",
            backdropSource: "override",
            backdropImageSha256: sha256,
          },
        },
      } as never,
      aspectRatio: "16:9",
      upload: async () => "/objects/7/uploads/generated.png",
    });
    expect(state.generated[0]!.prompt).toContain("APPROVED SCENE BACKDROP OVERRIDE");
  });
});