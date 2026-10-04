import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
// Test-only dependency: client acceptance must never authorize server requests.
import {
  buildDirectedVideoPayload, directedBlockReason, directedBrandOptions,
  emptyDirectedDraft, isDirectedCompatibleModel, DIRECTED_MODEL_IDS,
  type DirectedDraft,
} from "@workspace/video-director";
import type { VideoJobOptions } from "@workspace/db";

const storage = vi.hoisted(() => ({ bytes: Buffer.alloc(0), read: vi.fn() }));
vi.mock("../objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile(...args: unknown[]) {
      storage.read(...args);
      return {
        getMetadata: async () => [{ contentType: "image/png", size: storage.bytes.length }],
        download: async () => [storage.bytes],
      };
    }
  },
}));
vi.mock("@workspace/db", () => ({ db: {}, tenantsTable: {} }));
vi.mock("../brandKit/service", () => ({ loadActivePayload: vi.fn(async () => null) }));
vi.mock("../characters", () => ({ getCharacterDetail: vi.fn(), resolveOutfit: vi.fn(), loadReferenceImage: vi.fn() }));
vi.mock("./personalLikenessVideo", () => ({ freezePersonalLikenessVideoConsent: vi.fn(), assertFrozenPersonalLikenessVideoConsent: vi.fn() }));
vi.mock("../textGen", () => ({ getTextGenClient: vi.fn() }));
vi.mock("../aiCost", () => ({ usageAccountingParams: vi.fn(() => ({})) }));

import { freezeDirectedCast, freezeDirectedVideo, validateDirectedInput, validateDirectedModel } from "./directedVideo";
import { findVideoModel } from "./modelCatalog";
import { getCharacterDetail, resolveOutfit, loadReferenceImage } from "../characters";
import { freezePersonalLikenessVideoConsent } from "./personalLikenessVideo";

const asset = {
  key: "asset", name: "demo.png", kind: "image" as const, status: "ready" as const,
  objectPath: "/objects/1/demo.png", startSec: 0, endSec: 5, placement: "corner" as const,
};
const overlay = { key: "text", text: " Exact text ", startSec: 0, endSec: 5 };
const draft = (patch: Partial<DirectedDraft> = {}): DirectedDraft =>
  ({ ...emptyDirectedDraft(), enabled: true, ...patch });
const context = (durationSec = 5) => ({
  durationSec, hasCompatibleModel: true, modelSelected: true,
  brandKitId: null, brand: directedBrandOptions(null),
});
function accepted(input: DirectedDraft, duration = 5, cast = false) {
  expect(directedBlockReason(input, context(duration))).toBeNull();
  const payload = buildDirectedVideoPayload(input, { hasSelectedCast: cast })!;
  expect(payload).not.toBeNull();
  expect(() => validateDirectedInput(payload, duration)).not.toThrow();
  return payload;
}

beforeEach(async () => {
  vi.resetAllMocks();
  storage.bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
});

describe("client-accepted briefs against independent server rules", () => {
  it.each([
    ["optional fields absent", draft()],
    ["maximum assets and overlays", draft({
      assets: Array.from({ length: 3 }, (_, i) => ({ ...asset, key: `${i}`, placement: i === 0 ? "full_frame" : "corner" })),
      overlays: Array.from({ length: 5 }, (_, i) => ({ ...overlay, key: `${i}`, text: "x".repeat(160) })),
    })],
    ["minimum windows", draft({ assets: [{ ...asset, endSec: 0.1 }], overlays: [{ ...overlay, endSec: 0.1 }] })],
    ["exact ending boundary", draft({ assets: [{ ...asset, startSec: 4.5 }], overlays: [{ ...overlay, startSec: 4.5 }] })],
    ["trimmed prose", draft({ brandingInstructions: " teal ", fictionalCharacter: " a fictional barista ", overlays: [overlay] })],
  ] as const)("freezes %s without losing exact content", async (_name, input) => {
    const payload = accepted(input);
    const { directed, outro } = await freezeDirectedVideo(payload, 1, 5);
    expect(directed.assets).toEqual(payload.assets!.map(a => ({
      ...a, sha256: createHash("sha256").update(storage.bytes).digest("hex"),
    })));
    expect(directed.overlays).toEqual(payload.overlays);
    expect(directed.brandingInstructions).toBe(payload.brandingInstructions ?? "");
    expect(directed.fictionalCharacter).toBe(payload.fictionalCharacter ?? "");
    expect(outro.enabled).toBe(false);
  });

  it.each([
    ["assets", draft({ assets: Array(4).fill(asset) }), /Too many assets/],
    ["overlays", draft({ overlays: Array(6).fill(overlay) }), /Too many overlays/],
    ["text length", draft({ overlays: [{ ...overlay, text: "x".repeat(161) }] }), /1–160/],
    ["blank text", draft({ overlays: [{ ...overlay, text: "  " }] }), /1–160/],
  ] as const)("both sides reject excess %s", (_name, input, error) => {
    expect(directedBlockReason(input, context())).not.toBeNull();
    expect(() => validateDirectedInput(buildDirectedVideoPayload(input, { hasSelectedCast: false }), 5)).toThrow(error);
  });

  it.each([[NaN, 5], [0, Infinity], [-1, 5], [2, 2], [3, 2], [0, 5.01]])(
    "independently rejects invalid asset and overlay windows %s..%s", (startSec, endSec) => {
      for (const input of [
        draft({ assets: [{ ...asset, startSec, endSec }] }),
        draft({ overlays: [{ ...overlay, startSec, endSec }] }),
      ]) {
        expect(directedBlockReason(input, context())).not.toBeNull();
        expect(() => validateDirectedInput(buildDirectedVideoPayload(input, { hasSelectedCast: false }), 5)).toThrow(/times/);
      }
    },
  );

  it.each([...DIRECTED_MODEL_IDS.text, ...DIRECTED_MODEL_IDS.reference])(
    "resolves existing client ID %s through the real server catalog", id => {
      const cast = id.endsWith("-reference");
      expect(isDirectedCompatibleModel(id, cast)).toBe(true);
      const catalog = findVideoModel(id)!;
      expect(catalog).not.toBeNull();
      expect(catalog.durations).toEqual(Array.from({ length: 29 }, (_, i) => i + 2));
      for (const durationSec of catalog.durations) {
        const model = { provider: catalog.provider, model: catalog.models.text!, durationSec };
        accepted(draft({ overlays: [{ ...overlay, endSec: durationSec }] }), durationSec, cast);
        expect(() => validateDirectedModel(model, cast, durationSec)).not.toThrow();
        expect(() => validateDirectedModel(model, !cast, durationSec)).toThrow(/Choose Wan/);
        expect(() => validateDirectedModel({ ...model, provider: "byteplus" }, cast, durationSec)).toThrow(/Choose Wan/);
        expect(() => validateDirectedModel(model, cast, durationSec + 1)).toThrow(/exact requested duration/);
      }
    },
  );

  it("rejects unsupported models and out-of-range durations independently", () => {
    for (const model of ["alibaba/wan-3.0/image-to-video", "alibaba/wan-3.0-prime/image-to-video", "seedance", "alibaba/wan-3.0/text-to-video-extra"]) {
      expect(() => validateDirectedModel({ provider: "atlascloud", model, durationSec: 5 }, false, 5)).toThrow(/Choose Wan/);
    }
    expect(() => validateDirectedModel(undefined, false, 5)).toThrow(/Choose Wan/);
    for (const duration of [1, 31, NaN, Infinity]) {
      expect(() => validateDirectedInput({}, duration)).toThrow(/2–30/);
    }
  });

  it("rejects a client-accepted foreign asset before reading storage", async () => {
    const payload = accepted(draft({ assets: [{ ...asset, objectPath: "/objects/2/private.png" }] }));
    await expect(freezeDirectedVideo(payload, 1, 5)).rejects.toThrow(/tenant|belong|invalid/i);
    expect(storage.read).not.toHaveBeenCalled();
  });
});

describe("client acceptance never authorizes saved cast", () => {
  async function fixture() {
    const { directed } = await freezeDirectedVideo(accepted(draft(), 5, true), 1, 5);
    const character = {
      id: 10, tenantId: 1, referenceSource: "uploaded", referenceImagePath: "/objects/1/portrait.png",
      referenceSheetStatus: "approved", referenceSheetImagePath: "/objects/1/sheet.png",
      referenceSheetApprovedSha256: createHash("sha256").update(storage.bytes).digest("hex"),
      bytePlusIdentityId: null,
    };
    const outfit = { id: 20, tenantId: 1, characterId: 10, status: "approved", identityVerified: true, referenceImagePath: "/objects/1/outfit.png" };
    const detail = { character, outfits: [outfit] };
    vi.mocked(getCharacterDetail).mockResolvedValue(detail as never);
    vi.mocked(resolveOutfit).mockReturnValue(outfit as never);
    vi.mocked(loadReferenceImage).mockResolvedValue({ buffer: storage.bytes, mimeType: "image/png" } as never);
    vi.mocked(freezePersonalLikenessVideoConsent).mockResolvedValue(null);
    const options = {
      characterId: 10, outfitId: 20, directedVideo: directed,
      resolvedVideoModel: { provider: "atlascloud", model: "alibaba/wan-3.0/reference-to-video", durationSec: 5, generateAudio: true },
    } as VideoJobOptions;
    return { options, character, outfit };
  }

  it("requires tenant-scoped character lookup even when the client accepts", async () => {
    const { options } = await fixture();
    vi.mocked(getCharacterDetail).mockResolvedValue(null);
    await expect(freezeDirectedCast(options, 1)).rejects.toThrow(/unavailable/);
    expect(getCharacterDetail).toHaveBeenCalledWith(1, 10);
    expect(freezePersonalLikenessVideoConsent).not.toHaveBeenCalled();
    expect(options.directedVideo!.castApproval).toBeUndefined();
  });

  it.each(["provider identity", "snapshot provider identity", "sheet approval", "outfit approval", "outfit verification", "changed sheet"])(
    "rejects stale client acceptance for %s", async reason => {
      const { options, character, outfit } = await fixture();
      if (reason === "provider identity") Object.assign(character, { bytePlusIdentityId: 99 });
      if (reason === "snapshot provider identity") options.characterSnapshot = { character: { requiresBytePlusAsset: true } } as never;
      if (reason === "sheet approval") character.referenceSheetStatus = "pending";
      if (reason === "outfit approval") outfit.status = "pending";
      if (reason === "outfit verification") outfit.identityVerified = false;
      if (reason === "changed sheet") character.referenceSheetApprovedSha256 = "0".repeat(64);
      await expect(freezeDirectedCast(options, 1)).rejects.toThrow(
        reason.includes("provider") ? /different provider/ : reason === "changed sheet" ? /sheet changed/ : /Approve/,
      );
      expect(freezePersonalLikenessVideoConsent).not.toHaveBeenCalled();
      expect(options.directedVideo!.castApproval).toBeUndefined();
    },
  );

  it("propagates server consent denial rather than trusting client acceptance", async () => {
    const { options } = await fixture();
    vi.mocked(freezePersonalLikenessVideoConsent).mockRejectedValue(new Error("Consent has been revoked"));
    await expect(freezeDirectedCast(options, 1)).rejects.toThrow("Consent has been revoked");
    expect(freezePersonalLikenessVideoConsent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 1, provider: "atlascloud", model: "alibaba/wan-3.0/reference-to-video", scriptedSpeech: true,
      character: expect.objectContaining({ id: 10 }), outfit: expect.objectContaining({ id: 20 }),
    }));
    expect(options.directedVideo!.castApproval).toBeUndefined();
  });
});