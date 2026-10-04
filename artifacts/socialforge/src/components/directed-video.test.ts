import { describe, expect, it } from "vitest";
import {
  buildDirectedVideoPayload,
  classifyDirectedFile,
  directedBlockReason,
  directedCastRestriction,
  directedBrandOptions,
  emptyDirectedDraft,
  isDirectedCompatibleModel,
  type DirectedDraft,
} from "./directed-video";

const brand = directedBrandOptions(null);
const ctx = {
  durationSec: 5,
  hasCompatibleModel: true,
  modelSelected: true,
  brandKitId: null,
  brand,
};

function draft(p: Partial<DirectedDraft> = {}): DirectedDraft {
  return { ...emptyDirectedDraft(), enabled: true, ...p };
}

describe("directed video", () => {
  it("restricts models to Wan 3.0 Standard/Prime per mode", () => {
    expect(isDirectedCompatibleModel("atlascloud-wan-3.0-text-to-video", false)).toBe(true);
    expect(isDirectedCompatibleModel("atlascloud-wan-3.0-prime-reference", true)).toBe(true);
    expect(isDirectedCompatibleModel("atlascloud-wan-3.0-image-to-video", true)).toBe(false);
    expect(isDirectedCompatibleModel("atlascloud-wan-3.0-text-to-video", true)).toBe(false);
    expect(isDirectedCompatibleModel("wan-2.7", false)).toBe(false);
  });

  it("restricts real-person cast", () => {
    expect(directedCastRestriction({ identityId: 4 })).toMatch(/verified-identity/);
    // Server checks the exact source, consent grant, recipient and reference approvals.
    expect(directedCastRestriction({ provenanceStatus: "uploaded" })).toBeNull();
    expect(directedCastRestriction({ identityId: null, provenanceStatus: "verified_generated" })).toBeNull();
    expect(directedBlockReason(draft(), { ...ctx, castRestriction: "no" })).toBe("no");
  });

  it("validates asset files", () => {
    expect(classifyDirectedFile({ type: "image/png", size: 1000 })).toEqual({ kind: "image" });
    expect(classifyDirectedFile({ type: "image/png", size: 11 * 1024 * 1024 })).toHaveProperty("error");
    expect(classifyDirectedFile({ type: "video/webm", size: 39 * 1024 * 1024 })).toEqual({ kind: "video" });
    expect(classifyDirectedFile({ type: "image/gif", size: 10 })).toHaveProperty("error");
  });

  it("blocks without a compatible model and on bad bounds", () => {
    expect(directedBlockReason(draft(), { ...ctx, hasCompatibleModel: false })).toMatch(/Wan 3.0/);
    expect(
      directedBlockReason(
        draft({ overlays: [{ key: "a", text: "Sale", startSec: 1, endSec: 9 }] }),
        ctx,
      ),
    ).toMatch(/within the 5s/);
    expect(
      directedBlockReason(
        draft({
          assets: [{ key: "a", name: "x.png", kind: "image", status: "failed", objectPath: null, startSec: 0, endSec: 2, placement: "corner" }],
        }),
        ctx,
      ),
    ).toMatch(/failed/);
    expect(directedBlockReason(draft({ ending: "logo" }), ctx)).toMatch(/brand kit/);
  });

  it("builds payload and omits fictional character with saved cast", () => {
    const d = draft({
      fictionalCharacter: " a barista ",
      brandingInstructions: "teal",
      ending: "animation",
      overlays: [{ key: "o", text: " 20% off ", startSec: 0, endSec: 2 }],
      assets: [{ key: "a", name: "x.png", kind: "image", status: "ready", objectPath: "/objects/x", startSec: 1, endSec: 3, placement: "corner" }],
    });
    expect(buildDirectedVideoPayload(d, { hasSelectedCast: false })).toEqual({
      ending: "animation",
      brandImage: "none",
      brandingInstructions: "teal",
      fictionalCharacter: "a barista",
      assets: [{ objectPath: "/objects/x", startSec: 1, endSec: 3, placement: "corner" }],
      overlays: [{ text: "20% off", startSec: 0, endSec: 2 }],
    });
    expect(buildDirectedVideoPayload(d, { hasSelectedCast: true })).not.toHaveProperty("fictionalCharacter");
    expect(buildDirectedVideoPayload({ ...d, enabled: false }, { hasSelectedCast: false })).toBeNull();
  });
});
