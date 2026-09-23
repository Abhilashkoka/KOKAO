import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Readable } from "node:stream";
import { GenerateVideoBody } from "@workspace/api-zod";
import {
  assertReferencePath, assignReferenceImages, freezeReferenceImages,
  loadFrozenReference, referenceDigest, validateReferenceContent, validateReferenceMappings,
  type FrozenReferenceImage,
} from "./referenceImages";

const state = vi.hoisted(() => ({
  bytes: Buffer.alloc(0), size: 0, accesses: [] as string[], supports: true,
}));
vi.mock("../../objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile(path: string) {
      state.accesses.push(path);
      return {
        getMetadata: async () => [{ size: state.size }],
        createReadStream: () => Readable.from([state.bytes]),
      };
    }
  },
}));
vi.mock("../../imageGen", () => ({
  getImageGenSelection: async () => ({ provider: "test", model: "model", customBaseUrl: null, fallbackEnabled: false }),
  resolveImageGenProviderDef: async () => ({ id: "test" }),
  effectiveModel: () => "model",
  supportsReferenceInput: () => state.supports,
  isImageGenProviderConfigured: async () => true,
  getImageGenProviderDef: vi.fn(),
  rankImageGenProviders: vi.fn(),
}));
const ref = (id = "product", mode: FrozenReferenceImage["mode"] = "exact_insert"): FrozenReferenceImage => ({
  id, label: id, instructions: "Show the packaging", objectPath: "/objects/7/upload",
  mode, sha256: referenceDigest(state.bytes), mimeType: "image/png",
});
beforeEach(async () => {
  state.bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  state.size = state.bytes.length;
  state.accesses = [];
  state.supports = true;
});
describe("uploaded topic references", () => {
  it("rejects foreign objects, URLs and traversal before accessing storage", async () => {
    for (const path of ["/objects/8/upload", "https://example.com/image.png", "/objects/7/../8/x", "/objects/7/%2e%2e/x", "/objects/7/x?url=y"]) {
      expect(() => assertReferencePath(path, 7)).toThrow();
      await expect(freezeReferenceImages([{ ...ref(), objectPath: path }], 7, 4)).rejects.toThrow();
    }
    expect(state.accesses).toEqual([]);
  });
  it("validates actual image decoding and byte limits", async () => {
    expect(await validateReferenceContent(state.bytes)).toBe("image/png");
    await expect(validateReferenceContent(Buffer.from("<svg/>"))).rejects.toThrow("valid");
    await expect(validateReferenceContent(state.bytes.subarray(0, 40))).rejects.toThrow("valid");
    await expect(validateReferenceContent(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow("10 MB");
    state.size = 10 * 1024 * 1024 + 1;
    await expect(freezeReferenceImages([ref()], 7, 4)).rejects.toThrow("10 MB");
  });
  it("enforces six images in both the generated contract and service", () => {
    const refs = Array.from({ length: 7 }, (_, i) => ref(String(i)));
    expect(GenerateVideoBody.safeParse({ engine: "topic_to_video", referenceImages: refs }).success).toBe(false);
    expect(() => validateReferenceMappings(refs, 8)).toThrow("6");
  });
  it("rejects duplicate IDs, conflicting mapping and out-of-range scenes", () => {
    expect(() => validateReferenceMappings([ref(), ref()], 4)).toThrow("unique");
    expect(() => validateReferenceMappings([{ ...ref(), sceneNumbers: [5] }], 4)).toThrow("outside");
    expect(() => validateReferenceMappings([{ ...ref("a"), sceneNumbers: [2] }, { ...ref("b"), sceneNumbers: [2] }], 4)).toThrow("multiple");
    expect(() => validateReferenceMappings([ref("a"), ref("b")], 1)).toThrow("Not enough");
  });
  it("assigns every image deterministically with explicit mapping respected", () => {
    const refs = [ref("camera"), { ...ref("screen"), sceneNumbers: [3] }, ref("bottle")];
    const scenes = [{ text: "The bottle" }, { text: "A camera" }, { text: "Screen" }];
    const mapping = assignReferenceImages(refs, scenes);
    expect(mapping).toEqual([["bottle"], ["camera"], ["screen"]]);
    expect(assignReferenceImages(refs, scenes)).toEqual(mapping);
  });
  it("snapshots server hashes and retries with the exact original bytes", async () => {
    const untrusted = { ...ref(), sha256: "untrusted" };
    const frozen = await freezeReferenceImages([untrusted], 7, 4);
    expect(frozen.references[0]!.sha256).toBe(referenceDigest(state.bytes));
    expect(frozen.selection).toBeUndefined();
    expect((await loadFrozenReference(frozen.references[0]!, 7)).buffer).toEqual(state.bytes);
    state.bytes = await sharp(state.bytes).negate().png().toBuffer();
    await expect(loadFrozenReference(frozen.references[0]!, 7)).rejects.toThrow("changed");
  });
  it("rejects unsupported visual conditioning before funding and freezes a supported model", async () => {
    state.supports = false;
    await expect(freezeReferenceImages([ref("p", "visual_reference")], 7, 4)).rejects.toThrow("cannot use");
    state.supports = true;
    expect((await freezeReferenceImages([ref("p", "visual_reference")], 7, 4)).selection?.provider).toBe("test");
  });
});