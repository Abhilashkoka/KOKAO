import { describe, expect, it } from "vitest";
import * as shared from "../src";
// Exercise the actual public adapter paths too, so a future local override
// cannot silently diverge from the common rules.
import * as mobile from "../../../artifacts/mobile/lib/directedVideo";
import * as web from "../../../artifacts/socialforge/src/components/directed-video";
import type { DirectedVideoInput } from "@workspace/api-client-react";

const asset: shared.DirectedAssetDraft = {
  key: "asset", name: "demo.png", kind: "image", status: "ready",
  objectPath: "/objects/demo", startSec: 0, endSec: 5, placement: "corner",
};
const overlay = { key: "text", text: " Sale ", startSec: 0, endSec: 5 };
const ctx = {
  durationSec: 5, hasCompatibleModel: true, modelSelected: true,
  brandKitId: null, brand: shared.directedBrandOptions(null),
};
const draft = (patch: Partial<shared.DirectedDraft> = {}): shared.DirectedDraft =>
  ({ ...shared.emptyDirectedDraft(), enabled: true, ...patch });

it("both adapters re-export every shared rule rather than copying it", () => {
  for (const key of Object.keys(shared) as (keyof typeof shared)[]) {
    expect(mobile[key]).toBe(shared[key]);
    expect(web[key]).toBe(shared[key]);
  }
});

describe.each([["shared", shared], ["mobile", mobile], ["web", web]] as const)("%s director contract", (_name, api) => {
  it("allows exactly the existing four models, split by cast mode", () => {
    expect(api.DIRECTED_MODEL_IDS).toEqual({
      text: ["atlascloud-wan-3.0-text-to-video", "atlascloud-wan-3.0-prime-text-to-video"],
      reference: ["atlascloud-wan-3.0-reference", "atlascloud-wan-3.0-prime-reference"],
    });
    for (const cast of [false, true]) {
      for (const id of [...api.DIRECTED_MODEL_IDS.text, ...api.DIRECTED_MODEL_IDS.reference, "seedance", "atlascloud-wan-3.0-image-to-video", "unknown"]) {
        expect(api.isDirectedCompatibleModel(id, cast))
          .toBe((api.DIRECTED_MODEL_IDS[cast ? "reference" : "text"] as readonly string[]).includes(id));
      }
    }
    const models = [{ id: api.DIRECTED_MODEL_IDS.text[1] }, { id: "other" }, { id: api.DIRECTED_MODEL_IDS.text[0] }];
    expect(api.directedCompatibleModels(models, false)).toEqual([models[0], models[2]]);
    expect(api.directedCompatibleModels(undefined, true)).toEqual([]);
  });

  it("keeps supported durations and picks the first nearest duration on ties", () => {
    expect(api.directedDurationFor([5, 10], 10)).toBe(10);
    expect(api.directedDurationFor([5, 10], 8)).toBe(10);
    expect(api.directedDurationFor([10, 5], 7.5)).toBe(10);
    expect(api.directedDurationFor([], 7)).toBe(7);
    expect(api.directedDurationFor(null, 7)).toBe(7);
  });

  it("preserves opt-in defaults and independent draft arrays", () => {
    const a = api.emptyDirectedDraft();
    expect(a).toEqual({ enabled: false, brandingInstructions: "", fictionalCharacter: "", ending: "none", brandImage: "none", assets: [], overlays: [] });
    a.assets.push(asset);
    expect(api.emptyDirectedDraft().assets).toEqual([]);
    expect(api.directedBlockReason(a, { ...ctx, hasCompatibleModel: false })).toBeNull();
    expect(api.buildDirectedVideoPayload(a, { hasSelectedCast: false })).toBeNull();
  });

  it("pins exact count and text limits", () => {
    expect([api.DIRECTED_MAX_ASSETS, api.DIRECTED_MAX_OVERLAYS, api.DIRECTED_OVERLAY_MAX_CHARS]).toEqual([3, 5, 160]);
    expect(api.directedBlockReason(draft({ assets: Array(3).fill(asset), overlays: Array(5).fill({ ...overlay, text: "x".repeat(160) }) }), ctx)).toBeNull();
    expect(api.directedBlockReason(draft({ assets: Array(4).fill(asset) }), ctx)).toBe("Use at most 3 assets.");
    expect(api.directedBlockReason(draft({ overlays: Array(6).fill(overlay) }), ctx)).toBe("Use at most 5 text overlays.");
    expect(api.directedBlockReason(draft({ overlays: [{ ...overlay, text: "x".repeat(161) }] }), ctx)).toMatch(/160 characters/);
    expect(api.directedBlockReason(draft({ overlays: [{ ...overlay, text: " \n " }] }), ctx)).toMatch(/exact text/);
  });

  it.each([
    ["image/png", 10, "image"], ["image/jpeg", 10, "image"], ["image/webp", 10, "image"],
    ["video/mp4", 40, "video"], ["video/webm", 40, "video"],
  ])("classifies %s at the exact byte boundary", (type, mb, kind) => {
    expect(api.classifyDirectedFile({ type, size: Number(mb) * 1024 * 1024 })).toEqual({ kind });
    expect(api.classifyDirectedFile({ type, size: Number(mb) * 1024 * 1024 + 1 })).toHaveProperty("error");
    expect(api.classifyDirectedFile({ type: "image/gif", size: 1 })).toHaveProperty("error");
  });

  it.each([
    [NaN, 5, /enter start/], [0, Infinity, /enter start/], [-1, 5, /negative/],
    [2, 2, /after start/], [0, 0.09, /after start/], [0, 5.01, /within/],
  ])("rejects invalid timing %s..%s for assets and overlays", (startSec, endSec, error) => {
    expect(api.directedBlockReason(draft({ assets: [{ ...asset, startSec, endSec }] }), ctx)).toMatch(error);
    expect(api.directedBlockReason(draft({ overlays: [{ ...overlay, startSec, endSec }] }), ctx)).toMatch(error);
  });

  it("accepts minimum windows and blocks pending/failed uploads", () => {
    expect(api.directedBlockReason(draft({ assets: [{ ...asset, endSec: 0.1 }] }), ctx)).toBeNull();
    expect(api.directedBlockReason(draft({ assets: [{ ...asset, status: "uploading" }] }), ctx)).toMatch(/still uploading/);
    expect(api.directedBlockReason(draft({ assets: [{ ...asset, status: "failed" }] }), ctx)).toMatch(/failed to upload/);
    expect(api.directedBlockReason(draft({ assets: [{ ...asset, objectPath: null }] }), ctx)).toMatch(/failed to upload/);
  });

  it("requires model selection and preserves server-owned cast authority", () => {
    expect(api.directedBlockReason(draft(), { ...ctx, hasCompatibleModel: false })).toMatch(/not configured/);
    expect(api.directedBlockReason(draft(), { ...ctx, modelSelected: false })).toMatch(/Choose Wan/);
    expect(api.directedCastRestriction({ identityId: 1 })).toMatch(/verified-identity/);
    expect(api.directedCastRestriction({ identityId: null, provenanceStatus: "uploaded" })).toBeNull();
    expect(api.directedBlockReason(draft(), { ...ctx, castRestriction: "Approval required" })).toBe("Approval required");
  });

  it("requires opted-in brand assets but not a kit for plain branding instructions", () => {
    expect(api.directedBlockReason(draft({ brandingInstructions: "teal" }), ctx)).toBeNull();
    expect(api.directedBlockReason(draft({ ending: "logo" }), ctx)).toMatch(/Pick a brand kit/);
    const kitCtx = { ...ctx, brandKitId: 1 };
    expect(api.directedBlockReason(draft({ ending: "logo" }), kitCtx)).toMatch(/no primary logo/);
    expect(api.directedBlockReason(draft({ ending: "animation" }), kitCtx)).toMatch(/no logo animation/);
    for (const brandImage of ["primary", "secondary", "icon_mark"] as const) {
      expect(api.directedBlockReason(draft({ brandImage }), kitCtx)).toMatch(/not in this brand kit/);
      expect(api.directedBlockReason(draft({ brandImage }), {
        ...kitCtx, brand: { ...ctx.brand, logos: { ...ctx.brand.logos, [brandImage]: true } },
      })).toBeNull();
    }
  });

  it("serializes the unchanged API payload, trims prose and omits UI metadata", () => {
    const input = draft({ brandingInstructions: " teal ", fictionalCharacter: " barista ", ending: "animation", brandImage: "secondary", assets: [asset], overlays: [overlay] });
    const expected: DirectedVideoInput = {
      brandingInstructions: "teal", fictionalCharacter: "barista", ending: "animation", brandImage: "secondary",
      assets: [{ objectPath: "/objects/demo", startSec: 0, endSec: 5, placement: "corner" }],
      overlays: [{ text: "Sale", startSec: 0, endSec: 5 }],
    };
    expect(api.buildDirectedVideoPayload(input, { hasSelectedCast: false })).toEqual(expected);
    expect(api.buildDirectedVideoPayload(input, { hasSelectedCast: true })).toEqual({ ...expected, fictionalCharacter: undefined });
    expect(api.buildDirectedVideoPayload(draft({ brandingInstructions: " ", fictionalCharacter: "\n" }), { hasSelectedCast: false })).toEqual({ ending: "none", brandImage: "none", assets: [], overlays: [] });
    expect(input.overlays[0].text).toBe(" Sale ");
  });
});

it("keeps mobile approval checks and outfit selection intact", () => {
  const approved = { referenceSheetStatus: "approved", outfits: [{ id: 1, status: "approved", identityVerified: true }] };
  expect(mobile.directedCastReadiness(approved)).toBeNull();
  expect(mobile.directedCastReadiness({ ...approved, identityId: 9 })).toMatch(/verified-identity/);
  expect(mobile.directedCastReadiness({ ...approved, referenceSheetStatus: "pending" })).toMatch(/sheet is not approved/);
  expect(mobile.directedCastReadiness({ ...approved, outfits: [{ id: 1, status: "approved", identityVerified: false }] })).toMatch(/no approved outfit/);
  expect(mobile.directedApprovedOutfitId({ ...approved, outfits: [...approved.outfits, { id: 2, status: "approved", identityVerified: true, isDefault: true }] })).toBe(2);
});