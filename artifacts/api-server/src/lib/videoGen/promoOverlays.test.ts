import { describe, expect, it } from "vitest";
import {
  PromoOverlaysInputError,
  buildPromoTextAss,
  normalizePromoOverlays,
  overlayFontFamily,
  overlayWindow,
} from "./promoOverlays";
import { FACE_BUBBLE_FOOTAGE_RULE, guidedReferenceScriptBrief } from "./guidedReferences";

describe("normalizePromoOverlays", () => {
  it("keeps the previous value when omitted and clears on null", () => {
    const previous = { version: 1 as const, textOverlays: [], faceBubble: { enabled: true, corner: "top_left" as const } };
    expect(normalizePromoOverlays(undefined, previous)).toBe(previous);
    expect(normalizePromoOverlays(null, previous)).toBeNull();
  });

  it("trims text, fills defaults and drops empty lines", () => {
    expect(normalizePromoOverlays({ textOverlays: [{ text: "  ₹999   only " }, { text: "   " }] }, null)).toEqual({
      version: 1,
      textOverlays: [{ text: "₹999 only", position: "top", timing: "start", style: "red" }],
      faceBubble: null,
    });
  });

  it("returns null when nothing is switched on", () => {
    expect(normalizePromoOverlays({ textOverlays: [], faceBubble: { enabled: false, corner: "top_left" } }, null)).toBeNull();
  });

  it("rejects too many or too long lines", () => {
    expect(() => normalizePromoOverlays({ textOverlays: [1, 2, 3, 4].map(() => ({ text: "x" })) }, null)).toThrow(PromoOverlaysInputError);
    expect(() => normalizePromoOverlays({ textOverlays: [{ text: "x".repeat(61) }] }, null)).toThrow(/60 characters/);
  });
});

describe("on-screen text", () => {
  it("picks the bundled face for the script", () => {
    expect(overlayFontFamily("కొత్త కలెక్షన్ ₹999")).toBe("Noto Sans Telugu");
    expect(overlayFontFamily("नई कलेक्शन")).toBe("Noto Sans Devanagari");
    expect(overlayFontFamily("புதிய")).toBe("Noto Sans Tamil");
    expect(overlayFontFamily("30K Wala Kaam ₹999 Mein")).toBe("Anton");
  });

  it("times start, end and whole-video lines", () => {
    expect(overlayWindow("start", 20)).toEqual({ startSec: 0, endSec: 3 });
    expect(overlayWindow("end", 20)).toEqual({ startSec: 16, endSec: 20 });
    expect(overlayWindow("whole", 20)).toEqual({ startSec: 0, endSec: 20 });
  });

  it("writes an opaque-box ASS line per overlay without faux bold on Indic", () => {
    const ass = buildPromoTextAss({
      width: 1080,
      height: 1920,
      durationSec: 20,
      overlays: [
        { text: "Sale {now}", position: "top", timing: "start", style: "red" },
        { text: "కొత్త కలెక్షన్", position: "bottom", timing: "end", style: "yellow" },
      ],
    });
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toMatch(/Style: o0,Anton,86,&H00FFFFFF,&H00FFFFFF,&H003539E5,&H003539E5,-1,.*,3,/);
    expect(ass).toMatch(/Style: o1,Noto Sans Telugu,67,.*,0,0,0,0,100,100,0,0,3,/);
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:03.00,o0,,0,0,0,,{\\fad(200,200)}Sale now");
    expect(ass).toContain("Dialogue: 0,0:00:16.00,0:00:20.00,o1,");
  });
});

describe("face bubble script rule", () => {
  it("swaps the footage rule only when the bubble is on", () => {
    const library = {
      version: 1 as const,
      items: [{ id: "r1", handle: "rec", label: "rec", media: "video" as const, use: "footage" as const, path: "/p", sha256: "x", mimeType: "video/mp4", byteLength: 1, durationSeconds: 5, notes: "", aiDescription: null, transcript: null, documentText: null, voiceFor: null, rightsConfirmed: true }],
    };
    expect(guidedReferenceScriptBrief(library as never, { faceBubble: true })).toContain(FACE_BUBBLE_FOOTAGE_RULE);
    expect(guidedReferenceScriptBrief(library as never)).toContain("write narration only");
  });
});
