import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrandKitPayload } from "@workspace/db";
import { buildDefaultPayload } from "../brandKit/defaults";
import { parseHexColor, toCaptionStroke, loadVideoBranding } from "./branding";

const loadActivePayload = vi.hoisted(() => vi.fn());
vi.mock("../brandKit/service", () => ({ loadActivePayload }));

function payloadWith(mutate: (p: BrandKitPayload) => void): BrandKitPayload {
  const payload = buildDefaultPayload({ brandName: "Chai Point" });
  mutate(payload);
  return payload;
}

/** loadActivePayload resolves with { kit, payload, compiledStylePrompt }. */
function resolveWith(payload: BrandKitPayload) {
  loadActivePayload.mockResolvedValue({
    kit: { id: 7, tenantId: 1 },
    payload,
    compiledStylePrompt: null,
  });
}

describe("parseHexColor", () => {
  it("accepts 6-digit hex with or without the hash, in either case", () => {
    expect(parseHexColor("#FF8800")).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHexColor("ff8800")).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHexColor("  #0A0B0C  ")).toEqual({ r: 10, g: 11, b: 12 });
  });

  it("rejects shorthand, named, and malformed colors", () => {
    for (const bad of ["#FFF", "rebeccapurple", "", "#GGHHII", "#FF88000"]) {
      expect(parseHexColor(bad)).toBeNull();
    }
  });
});

describe("toCaptionStroke", () => {
  it("darkens the brand color so white caption text stays readable", () => {
    // 255 * 0.45 = 114.75 -> 115 (0x73); 136 * 0.45 = 61.2 -> 61 (0x3D)
    expect(toCaptionStroke("#FF8800")).toBe("0x733D00");
  });

  it("keeps black black and never exceeds the byte range", () => {
    expect(toCaptionStroke("#000000")).toBe("0x000000");
    expect(toCaptionStroke("#FFFFFF")).toBe("0x737373");
  });

  it("returns null for colors it cannot parse", () => {
    expect(toCaptionStroke("not-a-color")).toBeNull();
  });
});

describe("loadVideoBranding", () => {
  beforeEach(() => {
    loadActivePayload.mockReset();
  });

  it("returns null without touching the database when no kit is requested", async () => {
    expect(await loadVideoBranding(1, null)).toBeNull();
    expect(await loadVideoBranding(1, undefined)).toBeNull();
    expect(await loadVideoBranding(1, 0)).toBeNull();
    expect(loadActivePayload).not.toHaveBeenCalled();
  });

  it("returns null when the kit does not resolve for this tenant", async () => {
    loadActivePayload.mockResolvedValue(null);
    expect(await loadVideoBranding(1, 7)).toBeNull();
  });

  it("builds a voice hint from traits, audience, CTA style, and banned terms", async () => {
    resolveWith(
      payloadWith((p) => {
        p.voice.traits = ["warm", "practical", "never salesy"];
        p.identity.audience = ["cafe owners", "first-time founders"];
        p.voice.cta_style = "invite, never demand";
        p.brand_controls.restricted_terms = ["cheap", "guaranteed"];
      }),
    );
    const branding = await loadVideoBranding(1, 7);
    expect(branding?.voiceHint).toBe(
      "Voice: warm, practical, never salesy. Audience: cafe owners, first-time founders. " +
        "CTA style: invite, never demand. Never use these terms: cheap, guaranteed.",
    );
    expect(branding?.brandName).toBe("Chai Point");
  });

  it("has no voice hint when the kit carries no voice signal", async () => {
    resolveWith(payloadWith(() => {}));
    expect((await loadVideoBranding(1, 7))?.voiceHint).toBeNull();
  });

  it("uses the first parseable color, preferring primary over secondary", async () => {
    resolveWith(
      payloadWith((p) => {
        p.colors.primary = [{ name: "bad", hex: "not-hex" } as any];
        p.colors.secondary = [{ name: "ok", hex: "#FF8800" } as any];
      }),
    );
    expect((await loadVideoBranding(1, 7))?.accentColor).toBe("0x733D00");

    resolveWith(
      payloadWith((p) => {
        p.colors.primary = [{ name: "brand", hex: "#112233" } as any];
        p.colors.secondary = [{ name: "other", hex: "#FF8800" } as any];
      }),
    );
    expect((await loadVideoBranding(1, 7))?.accentColor).toBe("0x080F17");
  });

  it("has no accent color when every swatch is unparseable", async () => {
    resolveWith(
      payloadWith((p) => {
        p.colors.primary = [{ name: "bad", hex: "teal" } as any];
      }),
    );
    expect((await loadVideoBranding(1, 7))?.accentColor).toBeNull();
  });

  it("watermarks with the icon mark first, then the primary logo", async () => {
    resolveWith(
      payloadWith((p) => {
        p.logos.primary = { url: "/objects/1/uploads/primary.png" } as any;
        p.logos.icon_mark = { url: "/objects/1/uploads/icon.png" } as any;
      }),
    );
    expect((await loadVideoBranding(1, 7))?.watermarkPath).toBe("/objects/1/uploads/icon.png");

    resolveWith(
      payloadWith((p) => {
        p.logos.primary = { url: "/objects/1/uploads/primary.png" } as any;
      }),
    );
    expect((await loadVideoBranding(1, 7))?.watermarkPath).toBe("/objects/1/uploads/primary.png");
  });

  it("never watermarks with an external logo URL", async () => {
    resolveWith(
      payloadWith((p) => {
        p.logos.icon_mark = { url: "https://cdn.example.com/logo.png" } as any;
        p.logos.primary = { url: "http://example.com/p.png" } as any;
      }),
    );
    expect((await loadVideoBranding(1, 7))?.watermarkPath).toBeNull();
  });
});
