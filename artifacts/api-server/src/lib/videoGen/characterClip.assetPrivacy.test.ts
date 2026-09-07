import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  keyframe: vi.fn(),
  loadReference: vi.fn(),
  video: vi.fn(),
  currentExists: true,
  identityId: 3 as number | null,
}));
vi.mock("../characters", () => ({
  getCharacterDetail: async () => ({
    character: { id: 7, tenantId: 1, bytePlusIdentityId: mocks.identityId },
    outfits: [{ id: 9, tenantId: 1, characterId: 7, description: "red", referenceImagePath: "/private.png" }],
  }),
  resolveOutfit: (detail: { outfits: unknown[] }) => detail.outfits[0],
  loadReferenceImage: mocks.loadReference,
  generateSceneKeyframe: mocks.keyframe,
  characterDetailFromSnapshot: (_tenantId: number, snapshot: {
    character: Record<string, unknown>; outfits: Array<Record<string, unknown>>;
  }) => ({ character: snapshot.character, outfits: snapshot.outfits }),
}));
vi.mock("../characterAssets", () => ({
  assetRefsForOutfit: async () => [],
  atlasAssetRefsForOutfit: async () => [],
  currentBytePlusAssetPolicy: async () => ({
    exists: mocks.currentExists,
    requiresBytePlusAsset: mocks.currentExists && mocks.identityId !== null,
    requiresAtlasAsset: false,
  }),
}));
vi.mock("./motionPrompt", () => ({ getMotionInstruction: async () => "move" }));
vi.mock("./index", () => ({ generateVideo: mocks.video }));

import { generateCharacterClip } from "./characterClip";

describe("verified character fail-closed rendering", () => {
  it.each([
    undefined,
    { resolvedVideoModel: { version: 1, provider: "replicate", model: "other", resolvedAt: "now" } },
    { resolvedVideoModel: { version: 1, provider: "byteplus", model: "seedance", resolvedAt: "now" } },
  ])("never falls back to inline keyframes when active assets are missing", async (model) => {
    await expect(generateCharacterClip({
      tenantId: 1, characterId: 7, outfitId: 9, prompt: "scene", aspectRatio: "9:16",
      durationSec: 5, ...(model ? { model: model as never } : {}),
    })).rejects.toThrow(/requires active BytePlus assets/);
    expect(mocks.keyframe).not.toHaveBeenCalled();
    expect(mocks.video).not.toHaveBeenCalled();
  });

  it("does not downgrade a deleted character from its immutable enqueue policy", async () => {
    mocks.currentExists = false;
    await expect(generateCharacterClip({
      tenantId: 1, characterId: 7, outfitId: 9, prompt: "scene", aspectRatio: "9:16",
      durationSec: 5,
      wardrobeSnapshot: {
        character: {
          id: 7, name: "Deleted", description: "", referenceImagePath: "/deleted.png",
          referenceSource: "uploaded", requiresBytePlusAsset: true,
        },
        outfits: [{
          id: 9, name: "Default", description: "red", referenceImagePath: "/deleted-outfit.png",
          isDefault: true, bytePlusAssetId: null, bytePlusAssetStatus: "Processing",
        }],
      },
      model: { resolvedVideoModel: {
        version: 1, provider: "byteplus", model: "seedance", resolvedAt: "now",
      } } as never,
    })).rejects.toThrow(/snapshotted character was deleted/);
    expect(mocks.keyframe).not.toHaveBeenCalled();
    expect(mocks.video).not.toHaveBeenCalled();
    mocks.currentExists = true;
  });

  it("fails closed for a legacy snapshot after its current row was deleted", async () => {
    mocks.currentExists = false;
    await expect(generateCharacterClip({
      tenantId: 1, characterId: 7, outfitId: 9, prompt: "scene", aspectRatio: "9:16",
      durationSec: 5,
      wardrobeSnapshot: {
        character: { id: 7, name: "Legacy", description: "", referenceImagePath: "/legacy.png" },
        outfits: [{ id: 9, name: "Default", description: "red", referenceImagePath: "/legacy.png", isDefault: true }],
      },
    })).rejects.toThrow(/legacy character snapshot/);
    expect(mocks.keyframe).not.toHaveBeenCalled();
    expect(mocks.video).not.toHaveBeenCalled();
    mocks.currentExists = true;
  });

  it.each([
    ["uploaded", "uploaded", null],
    ["legacy", null, null],
    ["BytePlus identity", "generated", 73],
  ] as const)(
    "rejects an Atlas characterClip with a %s identity before any image or video call",
    async (_label, referenceSource, identityId) => {
      mocks.identityId = identityId;
      await expect(generateCharacterClip({
        tenantId: 1,
        characterId: 7,
        outfitId: 9,
        prompt: "scene",
        aspectRatio: "9:16",
        durationSec: 5,
        wardrobeSnapshot: {
          character: {
            id: 7,
            name: "Private",
            description: "",
            referenceImagePath: "/private.png",
            referenceSource,
            requiresBytePlusAsset: identityId !== null,
          },
          outfits: [{
            id: 9,
            name: "Default",
            description: "red",
            referenceImagePath: "/private.png",
            isDefault: true,
          }],
        },
        model: { resolvedVideoModel: {
          version: 1,
          provider: "atlascloud",
          model: "seedance-v2.5",
          resolvedAt: "now",
        } } as never,
      })).rejects.toThrow(/immutable AI-generated fictional identity/);
      expect(mocks.loadReference).not.toHaveBeenCalled();
      expect(mocks.keyframe).not.toHaveBeenCalled();
      expect(mocks.video).not.toHaveBeenCalled();
      mocks.identityId = 3;
    },
  );
});